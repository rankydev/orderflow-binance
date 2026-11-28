// Live-Format (KONZEPT §5.7, Etappe 1): Recorder → API → Browser per SSE. Rein, ohne I/O; Recorder
// (LiveTap), API (LiveHub) und Browser setzen den Zustand mit derselben Klasse LiveBook zusammen.
//
// Nachrichten (JSON, ein SSE-`data:` je Nachricht), alle mit v (Formatversion), sym, seq, serverMs:
//   snap    vollständiger Zustand: committedTo, from, alle Live-Minuten ab from, Preis, Status
//   tick    geänderte Minuten seit dem letzten tick (laufende Minute, ggf. abgeschlossene, noch nicht
//           geschriebene), letzter Preis, Ereigniszeit; mindestens 1 Hz (Herzschlag, dann ohne bars)
//   commit  Minute ts ist in der Datenbank (committedTo = ts + 60 s); Minuten < committedTo − 10 min
//           werden verworfen
//   status  Recorder/Stream/Lücke/eingefrorener Tag/Rückstand geändert
// seq zählt je Symbol und Strom lückenlos: ein Sprung heißt „Nachricht verloren" → neu verbinden (der
// neue Strom beginnt mit einem snap). Doppelte/verspätete Nachrichten (seq ≤ bekannt) werden ignoriert.
//
// Live-Daten sind vorläufig, die Datenbank bleibt die Wahrheit. Naht live → final: ein Bucket
// besteht aus dem DB-Anteil (Minuten < committedTo der /bars-Antwort) und den Live-Minuten mit
// ts ≥ diesem committedTo – disjunkt, ohne Doppelzählung, für jeden Zeitrahmen.
//
// Erweiterbar: neue Felder (z. B. Level/Footprint-Zellen, Big Orders) kommen additiv hinzu und werden
// von älteren Lesern ignoriert; nur ein unverträglicher Umbau erhöht LIVE_WIRE_VERSION.
import { MINUTE_MS } from '../constants.ts';

export const LIVE_WIRE_VERSION = 1;
/** So lange vor committedTo hält jeder Live-Zustand Minuten vor (Ablösen, verspätete Antworten). */
export const LIVE_RETAIN_MS = 10 * MINUTE_MS;
/** Höchstzahl Live-Minuten je Symbol (Datenbank steht → Rückstand wächst; älteste fallen weg). */
export const LIVE_MAX_MINUTES = 240;
/** Ereigniszeit so weit hinter der Serverzeit → „verzögert" (beides Uhr des Recorders). */
export const LIVE_DELAY_MS = 3_000;

/** Eine Minute (Bar) im Live-Format; Preise in price_unit, Mengen in Lots (wie bar_1m). */
export interface LiveBar {
  /** Minutenbeginn in ms UTC. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyQ: number;
  sellQ: number;
  /** Anzahl aggTrades je Seite. */
  buyA: number;
  sellA: number;
  firstAgg: number;
  lastAgg: number;
}

export interface LiveStatus {
  /** Recorder erreichbar (setzt die API bei Ausfall ihres Upstreams auf false). */
  recorder: boolean;
  /** Binance-Stream des Recorders verbunden. */
  stream: boolean;
  /** Lücke offen (REST holt nach): ab gapFrom keine Live-Daten, bis sie geschlossen ist. */
  catchUp: boolean;
  /** T des letzten lückenlosen Trades bei offener Lücke (ms) oder null. */
  gapFrom: number | null;
  /** Grund, wenn der laufende Tag nicht mehr live geschrieben wird; sonst null. */
  frozen: string | null;
  /** Abgeschlossene, noch nicht geschriebene Minuten (Schreibrückstand). */
  backlog: number;
}

export const STATUS_UNKNOWN: Readonly<LiveStatus> = Object.freeze({
  recorder: false,
  stream: false,
  catchUp: false,
  gapFrom: null,
  frozen: null,
  backlog: 0,
});

interface MsgBase {
  v: number;
  sym: string;
  seq: number;
  /** Uhr des Recorders in ms (status der API bei Upstream-Ausfall: letzte bekannte Recorder-Zeit). */
  serverMs: number;
}

export interface SnapMsg extends MsgBase {
  t: 'snap';
  /** Minuten < committedTo sind in der Datenbank (= data_day.live_until); null = unbekannt. */
  committedTo: number | null;
  /** Live-Minuten sind ab hier vollständig (ms); davor nichts. */
  from: number;
  price: number | null;
  /** Ereigniszeit E der letzten Stream-Nachricht (ms) oder null. */
  eventMs: number | null;
  bars: LiveBar[];
  status: LiveStatus;
}

export interface TickMsg extends MsgBase {
  t: 'tick';
  price: number | null;
  eventMs: number | null;
  bars: LiveBar[];
}

export interface CommitMsg extends MsgBase {
  t: 'commit';
  /** Beginn der geschriebenen Minute (ms). */
  ts: number;
  committedTo: number;
}

export interface StatusMsg extends MsgBase {
  t: 'status';
  status: LiveStatus;
}

export type LiveMsg = SnapMsg | TickMsg | CommitMsg | StatusMsg;

/** ok = angewendet; duplicate = seq schon bekannt (ignoriert); gap = Nachricht verloren → neu verbinden. */
export type ApplyResult = 'ok' | 'duplicate' | 'gap' | 'nosnap' | 'invalid';

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isNumOrNull = (x: unknown) => x === null || isNum(x);

function validBar(b: unknown): b is LiveBar {
  const o = b as Record<string, unknown>;
  return (
    typeof o === 'object' &&
    o !== null &&
    isNum(o.ts) &&
    o.ts % MINUTE_MS === 0 &&
    isNum(o.open) &&
    isNum(o.high) &&
    isNum(o.low) &&
    isNum(o.close) &&
    isNum(o.buyQ) &&
    isNum(o.sellQ) &&
    isNum(o.buyA) &&
    isNum(o.sellA) &&
    isNum(o.firstAgg) &&
    isNum(o.lastAgg)
  );
}

function validStatus(s: unknown): s is LiveStatus {
  const o = s as Record<string, unknown>;
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof o.recorder === 'boolean' &&
    typeof o.stream === 'boolean' &&
    typeof o.catchUp === 'boolean' &&
    isNumOrNull(o.gapFrom) &&
    (o.frozen === null || typeof o.frozen === 'string') &&
    isNum(o.backlog)
  );
}

/**
 * Prüft die Form einer Nachricht (aus JSON). Unbekannte Felder bleiben erlaubt (additive Erweiterung);
 * eine andere Formatversion oder ein unbekannter Typ ergibt null.
 */
export function parseLiveMsg(x: unknown): LiveMsg | null {
  const o = x as Record<string, unknown>;
  if (typeof o !== 'object' || o === null) return null;
  if (o.v !== LIVE_WIRE_VERSION || typeof o.sym !== 'string' || !Number.isSafeInteger(o.seq))
    return null;
  if (!isNum(o.serverMs)) return null;
  switch (o.t) {
    case 'snap':
      if (!isNumOrNull(o.committedTo) || !isNum(o.from) || !isNumOrNull(o.price)) return null;
      if (!isNumOrNull(o.eventMs) || !Array.isArray(o.bars) || !o.bars.every(validBar)) return null;
      if (!validStatus(o.status)) return null;
      return o as unknown as SnapMsg;
    case 'tick':
      if (!isNumOrNull(o.price) || !isNumOrNull(o.eventMs)) return null;
      if (!Array.isArray(o.bars) || !o.bars.every(validBar)) return null;
      return o as unknown as TickMsg;
    case 'commit':
      if (!isNum(o.ts) || !isNum(o.committedTo)) return null;
      return o as unknown as CommitMsg;
    case 'status':
      if (!validStatus(o.status)) return null;
      return o as unknown as StatusMsg;
    default:
      return null;
  }
}

/** Gleiche Minute in gleichem Stand? (lastAgg und Anzahl genügen: aggIds steigen streng) */
export function sameBar(a: LiveBar | undefined, b: LiveBar): boolean {
  return (
    a !== undefined &&
    a.ts === b.ts &&
    a.lastAgg === b.lastAgg &&
    a.firstAgg === b.firstAgg &&
    a.buyA + a.sellA === b.buyA + b.sellA
  );
}

export function sameStatus(a: LiveStatus, b: LiveStatus): boolean {
  return (
    a.recorder === b.recorder &&
    a.stream === b.stream &&
    a.catchUp === b.catchUp &&
    a.gapFrom === b.gapFrom &&
    a.frozen === b.frozen &&
    a.backlog === b.backlog
  );
}

/**
 * Live-Zustand eines Symbols aus snap + Deltas. Derselbe Code bei Sender (Recorder: wendet seine eigenen
 * Nachrichten an), Verteiler (API) und Empfänger (Browser).
 */
export class LiveBook {
  readonly sym: string;
  /** −1: noch kein snap. */
  seq = -1;
  committedTo: number | null = null;
  from = 0;
  readonly bars = new Map<number, LiveBar>();
  price: number | null = null;
  eventMs: number | null = null;
  serverMs = 0;
  status: LiveStatus = { ...STATUS_UNKNOWN };

  constructor(sym: string) {
    this.sym = sym;
  }

  get ready(): boolean {
    return this.seq >= 0;
  }

  apply(m: LiveMsg): ApplyResult {
    if (m.sym !== this.sym || m.v !== LIVE_WIRE_VERSION) return 'invalid';
    if (m.t === 'snap') {
      this.seq = m.seq;
      this.committedTo = m.committedTo;
      this.from = m.from;
      this.bars.clear();
      for (const b of m.bars) this.put(b);
      this.price = m.price;
      this.eventMs = m.eventMs;
      this.serverMs = m.serverMs;
      this.status = { ...m.status };
      this.cap();
      return 'ok';
    }
    if (this.seq < 0) return 'nosnap';
    if (m.seq <= this.seq) return 'duplicate';
    if (m.seq !== this.seq + 1) return 'gap';
    this.seq = m.seq;
    switch (m.t) {
      case 'tick':
        for (const b of m.bars) this.put(b);
        this.price = m.price;
        this.eventMs = m.eventMs;
        // Verzögerung = serverMs − eventMs desselben ticks (beides Uhr des Recorders); status- und
        // commit-Nachrichten verschieben serverMs nicht (eine API-Uhr mit Versatz zählt nicht)
        this.serverMs = m.serverMs;
        this.cap();
        break;
      case 'commit':
        this.commit(m.committedTo);
        break;
      case 'status':
        this.status = { ...m.status };
        break;
    }
    return 'ok';
  }

  private put(b: LiveBar): void {
    if (b.ts >= this.from) this.bars.set(b.ts, b);
  }

  private commit(committedTo: number): void {
    if (this.committedTo !== null && committedTo <= this.committedTo) return;
    this.committedTo = committedTo;
    const from = committedTo - LIVE_RETAIN_MS;
    if (from > this.from) {
      this.from = from;
      for (const ts of this.bars.keys()) if (ts < from) this.bars.delete(ts);
    }
  }

  /** Höchstens LIVE_MAX_MINUTES: älteste verwerfen und `from` nachziehen (sonst wüchse der Zustand). */
  private cap(): void {
    if (this.bars.size <= LIVE_MAX_MINUTES) return;
    const keys = [...this.bars.keys()].sort((a, b) => a - b);
    const drop = keys.length - LIVE_MAX_MINUTES;
    for (let i = 0; i < drop; i++) this.bars.delete(keys[i]!);
    this.from = keys[drop]!;
  }

  /** Minuten aufsteigend. */
  sortedBars(): LiveBar[] {
    return [...this.bars.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Neueste Minute oder null. */
  latest(): LiveBar | null {
    let best: LiveBar | null = null;
    for (const b of this.bars.values()) if (!best || b.ts > best.ts) best = b;
    return best;
  }

  /** Zustand als snap mit der Folgenummer `seq` (neuer Client; Verteiler mit eigener Zählung). */
  snapshot(seq: number, serverMs = this.serverMs): SnapMsg {
    return {
      v: LIVE_WIRE_VERSION,
      t: 'snap',
      sym: this.sym,
      seq,
      serverMs,
      committedTo: this.committedTo,
      from: this.from,
      price: this.price,
      eventMs: this.eventMs,
      bars: this.sortedBars(),
      status: { ...this.status },
    };
  }
}

// ---------------------------------------------------------------- Naht live → final (Browser)

/** OHLC + Mengen eines Buckets (genug für Kerzen, Volumen, Delta, Trade-Anzahl). */
export interface OhlcvLite {
  open: number;
  high: number;
  low: number;
  close: number;
  buyQ: number;
  sellQ: number;
  buyA: number;
  sellA: number;
}

/** Bucketbeginn (ms) einer Minute im Zeitrahmen tfSec (an der Epoche ausgerichtet wie time_bucket). */
export function bucketOf(ts: number, tfSec: number): number {
  const w = tfSec * 1000;
  return ts - (((ts % w) + w) % w);
}

/**
 * Live-Minuten, die nicht in der Datenbank-Antwort stecken: ts ≥ dbCommittedTo (committedTo derselben
 * /bars-Antwort), aufsteigend. `complete` = false, wenn der Live-Zustand nicht bis dbCommittedTo
 * zurückreicht (Minuten in [dbCommittedTo, from) fehlen beiden) → Abschnitt neu laden.
 */
export function liveTail(
  book: Pick<LiveBook, 'from' | 'sortedBars' | 'ready'>,
  dbCommittedTo: number,
): { bars: LiveBar[]; complete: boolean } {
  if (!book.ready) return { bars: [], complete: true };
  return {
    bars: book.sortedBars().filter((b) => b.ts >= dbCommittedTo),
    complete: dbCommittedTo >= book.from,
  };
}

/** Live-Minuten (aufsteigend) je Bucket des Zeitrahmens. */
export function groupByBucket(
  bars: readonly LiveBar[],
  tfSec: number,
): { ts: number; parts: LiveBar[] }[] {
  const out: { ts: number; parts: LiveBar[] }[] = [];
  for (const b of bars) {
    const t = bucketOf(b.ts, tfSec);
    const last = out[out.length - 1];
    if (last && last.ts === t) last.parts.push(b);
    else out.push({ ts: t, parts: [b] });
  }
  return out;
}

/**
 * DB-Anteil eines Buckets (oder null) + später liegende Live-Minuten (aufsteigend) → Bucket. Wie
 * composeBars für OHLC und Mengen: open des ersten, close des letzten Teils, Extreme, Summen.
 */
export function combineBars(base: OhlcvLite | null, parts: readonly LiveBar[]): OhlcvLite | null {
  let r: OhlcvLite | null = base ? { ...base } : null;
  for (const p of parts) {
    if (!r) {
      r = {
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
        buyQ: p.buyQ,
        sellQ: p.sellQ,
        buyA: p.buyA,
        sellA: p.sellA,
      };
      continue;
    }
    if (p.high > r.high) r.high = p.high;
    if (p.low < r.low) r.low = p.low;
    r.close = p.close;
    r.buyQ += p.buyQ;
    r.sellQ += p.sellQ;
    r.buyA += p.buyA;
    r.sellA += p.sellA;
  }
  return r;
}

/**
 * Ablösen prüfen: alter DB-Anteil + Live-Minuten in [altes, neues committedTo) eines Buckets müssen den
 * neuen DB-Anteil ergeben (OHLC, Volumen, Trade-Anzahl). '' = gleich, sonst die erste Abweichung.
 */
export function handoverDiff(
  oldDb: OhlcvLite | null,
  live: readonly LiveBar[],
  newDb: OhlcvLite | null,
): string {
  const exp = combineBars(oldDb, live);
  if (!exp && !newDb) return '';
  if (!exp || !newDb) return exp ? 'Bucket fehlt in der Datenbank' : 'Bucket fehlt live';
  for (const k of ['open', 'high', 'low', 'close'] as const)
    if (exp[k] !== newDb[k]) return `${k} live ${exp[k]} ≠ DB ${newDb[k]}`;
  if (exp.buyQ + exp.sellQ !== newDb.buyQ + newDb.sellQ)
    return `Volumen live ${exp.buyQ + exp.sellQ} ≠ DB ${newDb.buyQ + newDb.sellQ}`;
  if (exp.buyQ !== newDb.buyQ) return `buyQ live ${exp.buyQ} ≠ DB ${newDb.buyQ}`;
  if (exp.buyA + exp.sellA !== newDb.buyA + newDb.sellA)
    return `Trades live ${exp.buyA + exp.sellA} ≠ DB ${newDb.buyA + newDb.sellA}`;
  return '';
}

/** Bar (bar.ts) → LiveBar. */
export function liveBarOf(b: {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyQ: number;
  sellQ: number;
  buyA: number;
  sellA: number;
  firstAggId: number;
  lastAggId: number;
}): LiveBar {
  return {
    ts: b.ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    buyQ: b.buyQ,
    sellQ: b.sellQ,
    buyA: b.buyA,
    sellA: b.sellA,
    firstAgg: b.firstAggId,
    lastAgg: b.lastAggId,
  };
}
