// Binance-USDⓈ-M-Zugriff (geprüft gegen die offizielle Doku am 2026-11-25, siehe Bericht):
//  - WebSocket: wss://fstream.binance.com/market/stream?streams=<sym>@aggTrade/… (aggTrade liegt im
//    „Market"-Endpunkt; Legacy-URLs ohne /market liefern seit 2026-04-23 keine aggTrades). Verbindung
//    gilt 24 h; Server-Ping alle 3 min, Pong binnen 10 min (der WebSocket-Client antwortet selbst);
//    ≤ 10 eingehende Nachrichten/s an den Server; ≤ 1024 Streams je Verbindung.
//  - REST: https://fapi.binance.com/fapi/v1/aggTrades (IP-Gewicht 20, limit ≤ 1000, fromId inklusive,
//    nur die letzten 48 h); /fapi/v1/klines (Gewicht nach limit: < 100 → 1); IP-Limit
//    REQUEST_WEIGHT 2400/min laut exchangeInfo, Header X-MBX-USED-WEIGHT-1M; 429 → zurückweichen,
//    418 → IP-Sperre (2 min … 3 Tage).
import { parseAggTradeLine, parseKlineLine, type Kline, type SymbolSpec } from '@orderflow/core';
import type { FeedItem } from './feed.ts';

export const DEFAULT_WS_BASE = 'wss://fstream.binance.com/market';
export const DEFAULT_REST_BASE = 'https://fapi.binance.com';

/** aggTrade-Nachricht (WS `data` bzw. REST-Zeile) → FeedItem, exakt über den Vision-Zeilenparser. */
export function toItem(
  m: { a: number; p: string; q: string; f: number; l: number; T: number; m: boolean },
  spec: SymbolSpec,
  viaRest: boolean,
): FeedItem {
  const line = `${m.a},${m.p},${m.q},${m.f},${m.l},${m.T},${m.m ? 'true' : 'false'}`;
  return { trade: parseAggTradeLine(line, spec), line, viaRest };
}

/**
 * Gewichtsbudget je Minute (gleitendes 60-s-Fenster) plus Rückmeldung des Servers. Ein Request
 * wartet, bis sein Gewicht ins Budget passt; nach 429/418 wird bis zum Ablauf gesperrt.
 */
export class WeightBudget {
  private readonly perMinute: number;
  private readonly spent: { t: number; w: number }[] = [];
  private blockedUntil = 0;
  /** Zuletzt vom Server gemeldetes Gewicht (X-MBX-USED-WEIGHT-1M) und seine Minute. */
  private serverUsedValue = 0;
  private serverUsedMinute = -1;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    perMinute: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.perMinute = perMinute;
    this.now = now;
    this.sleep = sleep;
  }

  /** Servergewicht der laufenden Minute (der Zähler gilt je Kalenderminute; danach 0). */
  get serverUsed(): number {
    return Math.floor(this.now() / 60_000) === this.serverUsedMinute ? this.serverUsedValue : 0;
  }

  set serverUsed(v: number) {
    this.serverUsedValue = v;
    this.serverUsedMinute = Math.floor(this.now() / 60_000);
  }

  used(): number {
    const t = this.now();
    while (this.spent.length && this.spent[0]!.t <= t - 60_000) this.spent.shift();
    return this.spent.reduce((a, x) => a + x.w, 0);
  }

  /** Wartezeit (ms), bis `w` ins Budget passt (0 = sofort). */
  waitFor(w: number): number {
    const t = this.now();
    if (t < this.blockedUntil) return this.blockedUntil - t;
    // Serverstand: liegt er schon über dem Budget, bis zur nächsten vollen Minute warten
    if (this.serverUsed + w > this.perMinute && this.spent.length > 0) {
      return 60_000 - (t % 60_000);
    }
    let sum = this.used();
    if (sum + w <= this.perMinute) return 0;
    for (const x of this.spent) {
      sum -= x.w;
      if (sum + w <= this.perMinute) return x.t + 60_000 - t;
    }
    return 60_000;
  }

  async take(w: number): Promise<void> {
    for (let d = this.waitFor(w); d > 0; d = this.waitFor(w)) await this.sleep(d);
    this.spent.push({ t: this.now(), w });
  }

  block(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}

export interface RestSource {
  aggTrades(symbol: string, fromId: number, limit: number): Promise<RawAgg[]>;
  klines(symbol: string, startTime: number, limit: number): Promise<Kline[]>;
}

export interface RawAgg {
  a: number;
  p: string;
  q: string;
  f: number;
  l: number;
  T: number;
  m: boolean;
}

export class RestError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  constructor(status: number, code: number | undefined, msg: string) {
    super(msg);
    this.status = status;
    this.code = code;
  }
}

export class BinanceRest implements RestSource {
  private readonly base: string;
  readonly budget: WeightBudget;
  private readonly spec: (s: string) => SymbolSpec;
  requests = 0;
  weight = 0;

  constructor(base: string, budget: WeightBudget, spec: (s: string) => SymbolSpec) {
    this.base = base;
    this.budget = budget;
    this.spec = spec;
  }

  private async get(path: string, w: number): Promise<unknown> {
    await this.budget.take(w);
    const r = await fetch(this.base + path, { signal: AbortSignal.timeout(30_000) });
    this.requests++;
    this.weight += w;
    const used = Number(r.headers.get('x-mbx-used-weight-1m'));
    if (Number.isFinite(used)) this.budget.serverUsed = used;
    if (r.status === 429 || r.status === 418) {
      const ra = Number(r.headers.get('retry-after'));
      this.budget.block((Number.isFinite(ra) && ra > 0 ? ra : 60) * 1000);
      throw new RestError(r.status, undefined, `Binance ${r.status} (Rate-Limit) für ${path}`);
    }
    const body = (await r.json()) as unknown;
    if (!r.ok) {
      const b = body as { code?: number; msg?: string };
      throw new RestError(
        r.status,
        b.code,
        `Binance ${r.status} ${b.code ?? ''} ${b.msg ?? ''} für ${path}`,
      );
    }
    return body;
  }

  async aggTrades(symbol: string, fromId: number, limit: number): Promise<RawAgg[]> {
    return (await this.get(
      `/fapi/v1/aggTrades?symbol=${symbol}&fromId=${fromId}&limit=${limit}`,
      20,
    )) as RawAgg[];
  }

  async klines(symbol: string, startTime: number, limit: number): Promise<Kline[]> {
    const w = limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
    const rows = (await this.get(
      `/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=${limit}`,
      w,
    )) as (string | number)[][];
    const spec = this.spec(symbol);
    // REST-Klines haben dieselben Felder wie die Vision-Dumps
    return rows.map((r) => parseKlineLine(r.map(String).join(','), spec));
  }
}
