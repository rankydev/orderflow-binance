// Live-Updates im Browser (KONZEPT §5.7, Etappe 1): SSE GET /api/v1/live?sym=… → LiveBook
// (@orderflow/core wire.ts). Der Browser spricht nie mit Binance; Live-Daten sind vorläufig, die
// /bars-Antworten (Datenbank) bleiben die Wahrheit.
//
// Reine Teile (unit-getestet): Statusautomat (liveUiState), Naht DB/Live je Bucket (composeLive),
// Einarbeiten in die Item-Liste des Fensters (mergeLive), Ablöseprüfung (checkHandover), Backoff.
// LiveClient: Verbindung, Neuverbinden mit Backoff, Sequenzsprung → neu verbinden, Stille-Wächter,
// unsichtbarer Tab → nach 30 s trennen, beim Sichtbarwerden neu verbinden.
import {
  bucketOf,
  combineBars,
  groupByBucket,
  handoverDiff,
  LIVE_DELAY_MS,
  LiveBook,
  parseLiveMsg,
  type LiveBar,
  type LiveMsg,
  type LiveStatus,
  type OhlcvLite,
} from '@orderflow/core/browser';
import type { UTCTimestamp } from 'lightweight-charts';
import type { BarItem } from './types.ts';

export type LiveUiState = 'live' | 'quiet' | 'delayed' | 'disconnected' | 'catchup' | 'frozen';

/** Ohne tick so lange (ms, Zeitspanne im Browser – keine Uhrzeit) → „getrennt" (Tap: ≥ 1 tick/s). */
export const LIVE_TICK_SILENCE_MS = 5_000;
/** Ohne jede Nachricht so lange → Verbindung tot, neu verbinden (die API sendet bei Ausfall alle 5 s status). */
export const LIVE_SILENCE_MS = 8_000;
/** „verzögert": Verzögerung > 3 s in zwei aufeinanderfolgenden ticks … */
export const LIVE_DELAY_ON_MS = LIVE_DELAY_MS;
/** … endet, wenn sie mindestens LIVE_SETTLE_MS lang unter LIVE_DELAY_OFF_MS bleibt. */
export const LIVE_DELAY_OFF_MS = 1_500;
export const LIVE_SETTLE_MS = 5_000;
/** Stream verbunden, aber so lange keine Trades → „ruhig" (nicht „verzögert"). */
export const LIVE_QUIET_MS = 30_000;
/** Unsichtbarer Tab: nach so langer Zeit trennen. */
export const LIVE_HIDDEN_DISCONNECT_MS = 30_000;
/** Nach einem commit den letzten vorläufigen Abschnitt nach 0…LIVE_RELOAD_JITTER_MS neu laden. */
export const LIVE_RELOAD_JITTER_MS = 2_000;

export const LIVE_LABELS: Record<LiveUiState, string> = {
  live: 'live',
  quiet: 'ruhig / keine Trades',
  delayed: 'verzögert',
  disconnected: 'getrennt',
  catchup: 'Recorder holt nach / Lücke',
  frozen: 'Tag eingefroren',
};

/**
 * Entprellte Live-Gesundheit, gemessen nur mit der Uhr des Recorders (serverMs, recvMs, eventMs der
 * ticks), nie mit der des Besuchers:
 *  - Verzögerung = recvMs − eventMs (Empfang beim Recorder minus Binance-Ereigniszeit; ohne recvMs,
 *    älterer Recorder: serverMs − eventMs). „verzögert" ab > 3 s in zwei aufeinanderfolgenden ticks,
 *    vorbei nach ≥ 5 s ununterbrochen < 1,5 s.
 *  - Ruhe = serverMs − recvMs: bei verbundenem Stream kein Fehler; erst > 30 s → „ruhig".
 *  - Stream getrennt (status.stream false) zählt erst nach ≥ 5 s als „holt nach" (kurze Reconnects
 *    lassen kein Banner blinken).
 */
export class LiveHealth {
  delayed = false;
  /** Recorder-Zeit des letzten ticks */
  serverMs = 0;
  /** Ruhe (ms) beim letzten tick */
  quietMs = 0;
  private over = 0;
  private goodSince: number | null = null;
  private streamDownSince: number | null = null;

  reset(): void {
    this.delayed = false;
    this.serverMs = 0;
    this.quietMs = 0;
    this.over = 0;
    this.goodSince = null;
    this.streamDownSince = null;
  }

  tick(serverMs: number, eventMs: number | null, recvMs: number | null | undefined): void {
    this.serverMs = serverMs;
    const recv = recvMs ?? serverMs;
    this.quietMs = recvMs != null ? Math.max(0, serverMs - recvMs) : 0;
    const lag = eventMs === null ? null : recv - eventMs;
    if (lag !== null && lag > LIVE_DELAY_ON_MS) {
      this.over++;
      this.goodSince = null;
      if (this.over >= 2) this.delayed = true;
    } else {
      this.over = 0;
      if (!this.delayed) return;
      if (lag !== null && lag < LIVE_DELAY_OFF_MS) {
        this.goodSince ??= serverMs;
        if (serverMs - this.goodSince >= LIVE_SETTLE_MS) {
          this.delayed = false;
          this.goodSince = null;
        }
      } else this.goodSince = null;
    }
  }

  status(serverMs: number, st: LiveStatus): void {
    if (st.stream) this.streamDownSince = null;
    else this.streamDownSince ??= serverMs;
  }

  /** wie lange (ms, Recorder-Uhr) der Stream schon getrennt ist; 0 = verbunden */
  streamDownMs(): number {
    return this.streamDownSince === null ? 0 : Math.max(0, this.serverMs - this.streamDownSince);
  }
}

/** Zustände (Reihenfolge = Vorrang). */
export function liveUiState(x: {
  connected: boolean;
  ready: boolean;
  status: LiveStatus;
  /** ms seit dem letzten tick (Browser-Zeitspanne, performance.now) */
  tickSilentMs: number;
  delayed: boolean;
  /** Ruhe beim Recorder (serverMs − recvMs) */
  quietMs: number;
  /** Stream getrennt seit (Recorder-Uhr) */
  streamDownMs: number;
}): LiveUiState {
  if (!x.connected || !x.ready || !x.status.recorder || x.tickSilentMs > LIVE_TICK_SILENCE_MS)
    return 'disconnected';
  if (x.status.frozen) return 'frozen';
  if (x.status.catchUp || (!x.status.stream && x.streamDownMs >= LIVE_SETTLE_MS)) return 'catchup';
  if (x.delayed) return 'delayed';
  if (x.quietMs > LIVE_QUIET_MS) return 'quiet';
  return 'live';
}

/** Wartezeit vor dem n-ten Neuverbinden (1 s, 2 s, 4 s … ≤ 30 s, +0…30 % Streuung). */
export function reconnectDelayMs(attempt: number, rnd = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (1 + 0.3 * rnd()));
}

/** Item → OHLCV (ganzzahlige Preise). */
export function liteOf(it: BarItem): OhlcvLite {
  return {
    open: it.o,
    high: it.h,
    low: it.l,
    close: it.c,
    buyQ: it.b,
    sellQ: it.s,
    buyA: it.ba,
    sellA: it.sa,
  };
}

/** OHLCV → Item; `live`: Bucket enthält Live-Minuten (vorläufig). Zusatzspalten (x.*) entfallen. */
export function itemOf(tSec: number, b: OhlcvLite, priceDecimals: number, live: boolean): BarItem {
  const f = 10 ** priceDecimals;
  return {
    time: tSec as UTCTimestamp,
    t: tSec,
    open: b.open / f,
    high: b.high / f,
    low: b.low / f,
    close: b.close / f,
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.buyQ + b.sellQ,
    b: b.buyQ,
    s: b.sellQ,
    ba: b.buyA,
    sa: b.sellA,
    ...(live ? { live: true } : {}),
  };
}

export interface ChunkView {
  /** committedTo der geladenen /bars-Antwort (ms) oder undefined (nicht geladen / älterer Server). */
  committedTo(c: number): number | undefined;
  /** DB-Item des Abschnitts c zur Bucketzeit tSec oder null. */
  itemAt(c: number, tSec: number): BarItem | null;
}

/**
 * Live-Buckets für die Abschnitte [c0, c1]: je Bucket mit Live-Minuten ts ≥ committedTo seines
 * Abschnitts DB-Anteil + Live-Minuten (disjunkt). `reload`: Abschnitte, deren committedTo älter ist als
 * der Live-Vorhalt (`from`) – dort fehlen Minuten beiden Seiten → neu laden. `beyond`: Live-Minuten
 * im Abschnitt direkt nach c1 (der Live-Rand hat das Fenster verlassen → Fenster wachsen lassen).
 */
export function composeLive(
  tail: readonly LiveBar[],
  from: number,
  tfSec: number,
  chunkSpanSec: number,
  win: [number, number],
  view: ChunkView,
  priceDecimals: number,
): { items: BarItem[]; reload: number[]; beyond: boolean } {
  const items: BarItem[] = [];
  const reload: number[] = [];
  let beyond = false;
  const byChunk = new Map<number, LiveBar[]>();
  for (const b of tail) {
    const c = Math.floor(bucketOf(b.ts, tfSec) / 1000 / chunkSpanSec);
    if (c === win[1] + 1) beyond = true;
    if (c < win[0] || c > win[1]) continue;
    let a = byChunk.get(c);
    if (!a) byChunk.set(c, (a = []));
    a.push(b);
  }
  for (const c of [...byChunk.keys()].sort((a, b) => a - b)) {
    const C = view.committedTo(c);
    if (C === undefined) continue;
    if (C < from) reload.push(c);
    const parts = byChunk.get(c)!.filter((b) => b.ts >= C);
    for (const g of groupByBucket(parts, tfSec)) {
      const tSec = g.ts / 1000;
      const db = view.itemAt(c, tSec);
      const merged = combineBars(db ? liteOf(db) : null, g.parts);
      if (merged) items.push(itemOf(tSec, merged, priceDecimals, true));
    }
  }
  return { items, reload, beyond };
}

function sameItem(a: BarItem, b: BarItem): boolean {
  return (
    a.time === b.time &&
    a.o === b.o &&
    a.h === b.h &&
    a.l === b.l &&
    a.c === b.c &&
    a.b === b.b &&
    a.s === b.s &&
    a.ba === b.ba &&
    a.sa === b.sa &&
    !!a.live === !!b.live
  );
}

/**
 * Buckets (aufsteigend) in die Item-Liste einarbeiten (verändert `items`): ersetzen oder hinten
 * anhängen. `updates` in Reihenfolge für series.update(item, historical); `rebuild` = ein Bucket läge
 * mitten zwischen vorhandenen Items (nur mit setData möglich).
 */
export function mergeLive(
  items: BarItem[],
  add: readonly BarItem[],
  /** true (vor setData): mittendrin einfügen statt `rebuild` zu melden */
  allowInsert = false,
): { updates: { item: BarItem; historical: boolean }[]; rebuild: boolean } {
  const updates: { item: BarItem; historical: boolean }[] = [];
  for (const m of add) {
    const n = items.length;
    // meist am Ende: von hinten suchen
    let i = n - 1;
    while (i >= 0 && items[i]!.time > m.time) i--;
    if (i >= 0 && items[i]!.time === m.time) {
      if (!sameItem(items[i]!, m)) {
        items[i] = m;
        updates.push({ item: m, historical: i < n - 1 });
      }
    } else if (i === n - 1) {
      items.push(m);
      updates.push({ item: m, historical: false });
    } else if (allowInsert) {
      items.splice(i + 1, 0, m);
    } else return { updates, rebuild: true };
  }
  return { updates, rebuild: false };
}

/**
 * Ablösen eines Abschnitts prüfen: je Bucket mit Live-Minuten in [oldC, newC) muss alter DB-Anteil +
 * diese Minuten den neuen DB-Anteil ergeben. Liefert die Abweichungen (leer = alles gleich) und die
 * Zahl geprüfter Buckets. Ohne lückenlosen Live-Stand ab oldC (from > oldC) wird nicht geprüft.
 */
export function checkHandover(
  live: readonly LiveBar[],
  from: number,
  oldC: number,
  newC: number,
  tfSec: number,
  oldDb: (tSec: number) => BarItem | null,
  newDb: (tSec: number) => BarItem | null,
): { checked: number; diffs: string[] } {
  if (newC <= oldC || from > oldC) return { checked: 0, diffs: [] };
  const parts = live.filter((b) => b.ts >= oldC && b.ts < newC);
  const diffs: string[] = [];
  let checked = 0;
  for (const g of groupByBucket(parts, tfSec)) {
    const t = g.ts / 1000;
    const o = oldDb(t);
    const n = newDb(t);
    const d = handoverDiff(o ? liteOf(o) : null, g.parts, n ? liteOf(n) : null);
    checked++;
    if (d) diffs.push(`${new Date(g.ts).toISOString()}: ${d}`);
  }
  return { checked, diffs };
}

// ---------------------------------------------------------------- Verbindung

export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface LiveClientOptions {
  base: string;
  factory?: (url: string) => EventSourceLike;
  /** Zeitspanne (ms, monoton) */
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  /** Sichtbarkeit (Standard document); null = immer sichtbar */
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> | null;
  onChange: (kind: LiveMsg['t'] | 'conn', m?: LiveMsg) => void;
}

export class LiveClient {
  book: LiveBook | null = null;
  connected = false;
  /** Tab unsichtbar und getrennt (verbindet beim Sichtbarwerden). */
  paused = false;
  readonly stats = { connects: 0, gaps: 0, invalid: 0, messages: 0, silences: 0 };
  private sym: string | null = null;
  private es: EventSourceLike | null = null;
  private attempt = 0;
  private lastMsgAt = 0;
  private lastTickAt = 0;
  /** Entprellte Verzögerung/Ruhe/Stream (Recorder-Uhr) */
  readonly health = new LiveHealth();
  private retry: unknown = null;
  private hiddenTimer: unknown = null;
  private watchdog: unknown = null;
  private closed = false;
  private readonly o: Required<Omit<LiveClientOptions, 'doc'>> & Pick<LiveClientOptions, 'doc'>;
  private readonly onVis = () => this.visibility();

  constructor(o: LiveClientOptions) {
    this.o = {
      factory: (u) => new EventSource(u) as unknown as EventSourceLike,
      now: () => performance.now(),
      setTimer: (f, ms) => setTimeout(f, ms),
      clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      ...o,
      doc: o.doc === undefined ? (typeof document === 'undefined' ? null : document) : o.doc,
    };
    this.o.doc?.addEventListener('visibilitychange', this.onVis);
  }

  get symbol(): string | null {
    return this.sym;
  }

  setSymbol(sym: string): void {
    if (sym === this.sym || this.closed) return;
    this.sym = sym;
    this.attempt = 0;
    this.book = null;
    this.disconnect();
    if (!this.hidden()) this.connect();
    else this.paused = true;
    this.o.onChange('conn');
  }

  /** ms seit der letzten Nachricht. */
  silentMs(): number {
    return this.connected ? this.o.now() - this.lastMsgAt : Infinity;
  }

  /** ms seit dem letzten tick bzw. snap (status-Herzschläge der API zählen nicht). */
  tickSilentMs(): number {
    return this.connected ? this.o.now() - this.lastTickAt : Infinity;
  }

  uiState(): LiveUiState {
    const b = this.book;
    return liveUiState({
      connected: this.connected,
      ready: !!b?.ready,
      status: b?.status ?? {
        recorder: false,
        stream: false,
        catchUp: false,
        gapFrom: null,
        frozen: null,
        backlog: 0,
      },
      tickSilentMs: this.tickSilentMs(),
      delayed: this.health.delayed,
      quietMs: this.health.quietMs,
      streamDownMs: this.health.streamDownMs(),
    });
  }

  close(): void {
    this.closed = true;
    this.disconnect();
    this.o.doc?.removeEventListener('visibilitychange', this.onVis);
  }

  private hidden(): boolean {
    return this.o.doc?.visibilityState === 'hidden';
  }

  private visibility(): void {
    if (this.closed || !this.sym) return;
    if (this.hidden()) {
      if (this.hiddenTimer === null)
        this.hiddenTimer = this.o.setTimer(() => {
          this.hiddenTimer = null;
          if (!this.hidden()) return;
          this.disconnect();
          this.paused = true;
          this.o.onChange('conn');
        }, LIVE_HIDDEN_DISCONNECT_MS);
    } else {
      if (this.hiddenTimer !== null) this.o.clearTimer(this.hiddenTimer);
      this.hiddenTimer = null;
      if (this.paused) {
        this.paused = false;
        this.attempt = 0;
        this.connect();
      }
    }
  }

  private connect(): void {
    if (this.closed || !this.sym || this.es) return;
    const sym = this.sym;
    const url = `${this.o.base}/api/v1/live?sym=${encodeURIComponent(sym)}`;
    let es: EventSourceLike;
    try {
      es = this.o.factory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.es = es;
    this.stats.connects++;
    this.book = new LiveBook(sym);
    this.health.reset();
    this.lastMsgAt = this.o.now();
    this.lastTickAt = this.o.now();
    es.onopen = () => {
      if (this.es !== es) return;
      this.connected = true;
      this.lastMsgAt = this.o.now();
      this.lastTickAt = this.o.now();
      this.o.onChange('conn');
    };
    es.onmessage = (ev) => {
      if (this.es !== es) return;
      this.onMessage(ev.data);
    };
    es.onerror = () => {
      if (this.es !== es) return;
      // eigenes Neuverbinden mit Backoff (der Browser-Automatismus kennt keinen Sequenzsprung)
      this.disconnect();
      this.o.onChange('conn');
      this.scheduleReconnect();
    };
    this.watchdog = this.o.setTimer(() => this.watch(es), 2_000);
  }

  private watch(es: EventSourceLike): void {
    if (this.es !== es) return;
    // tot: gar nichts mehr (die API sendet auch bei Recorder-Ausfall alle 5 s status) – oder keine
    // ticks, obwohl der Recorder laut letztem Stand erreichbar ist (hängender Verteiler)
    const now = this.o.now();
    if (
      this.connected &&
      (now - this.lastMsgAt > LIVE_SILENCE_MS ||
        (now - this.lastTickAt > 2 * LIVE_TICK_SILENCE_MS && !!this.book?.status.recorder))
    ) {
      this.stats.silences++;
      this.reconnectNow();
      return;
    }
    this.o.onChange('conn'); // Statusanzeige auch ohne Nachrichten auffrischen
    this.watchdog = this.o.setTimer(() => this.watch(es), 2_000);
  }

  private onMessage(data: string): void {
    this.lastMsgAt = this.o.now();
    this.connected = true;
    let m: LiveMsg | null;
    try {
      m = parseLiveMsg(JSON.parse(data));
    } catch {
      m = null;
    }
    if (!m || !this.book) {
      this.stats.invalid++;
      return;
    }
    if (m.sym !== this.sym) return;
    this.stats.messages++;
    const r = this.book.apply(m);
    if (r === 'gap' || r === 'nosnap') {
      this.stats.gaps++;
      this.reconnectNow();
      return;
    }
    if (r !== 'ok') return;
    if (m.t === 'snap') {
      this.attempt = 0;
      this.health.reset();
      this.health.status(m.serverMs, m.status);
    }
    if (m.t === 'snap' || m.t === 'tick') {
      this.lastTickAt = this.lastMsgAt;
      this.health.tick(m.serverMs, m.eventMs, m.recvMs);
    } else if (m.t === 'status') this.health.status(m.serverMs, m.status);
    this.o.onChange(m.t, m);
  }

  /** Sofort neu verbinden (Sequenzsprung, Stille) – zählt als Versuch. */
  private reconnectNow(): void {
    this.disconnect();
    this.o.onChange('conn');
    this.scheduleReconnect(true);
  }

  private scheduleReconnect(soon = false): void {
    if (this.closed || this.retry !== null) return;
    if (this.hidden()) {
      this.paused = true;
      return;
    }
    const ms = soon && this.attempt === 0 ? 0 : reconnectDelayMs(this.attempt);
    this.attempt++;
    this.retry = this.o.setTimer(() => {
      this.retry = null;
      this.connect();
    }, ms);
  }

  private disconnect(): void {
    if (this.retry !== null) this.o.clearTimer(this.retry);
    this.retry = null;
    if (this.watchdog !== null) this.o.clearTimer(this.watchdog);
    this.watchdog = null;
    const es = this.es;
    this.es = null;
    this.connected = false;
    es?.close();
  }
}
