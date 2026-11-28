// Live-Tap (KONZEPT §5.7, Etappe 1): liest den Zustand des Recorders nur (LiveDay/DayAggregator:
// minuteBar, openMinuteView; Feed, Stream, Warteschlange) und sendet ihn als SSE auf GET /live
// (höchstens 2 Clients – die API braucht einen). Format und Zusammensetzung: @orderflow/core wire.ts.
//
//  - OF_LIVE_HZ (Standard 4) Durchgänge je Sekunde: Diff gegen den zuletzt gesendeten Stand (eigenes
//    LiveBook, auf das jede gesendete Nachricht angewendet wird) → `tick` mit den geänderten Minuten;
//    ohne Änderung höchstens 1 s Pause (Herzschlag).
//  - Je festgeschriebener Minute sofort `commit` im selben Strom (vorher ein Durchgang, damit die
//    abgeschlossene Fassung der Minute vor ihrem commit beim Client ist).
//  - Status (Stream, Lücke, eingefrorener Tag, Rückstand) bei Änderung als `status`.
//  - Jeder Fehler wird hier abgefangen und gezählt; handle(), Aggregation und Schreiben merken davon
//    nichts. Die Tap verändert den Recorder nie.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DAY_MS,
  LIVE_RETAIN_MS,
  LIVE_WIRE_VERSION,
  LiveBook,
  liveBarOf,
  MINUTE_MS,
  sameBar,
  sameStatus,
  type LiveBar,
  type LiveMsg,
  type LiveStatus,
} from '@orderflow/core';
import { EventHub } from './events.ts';
import type { Recorder, SymbolState } from './recorder.ts';

export const LIVE_HZ_DEFAULT = 4;
export const LIVE_MAX_CLIENTS = 2;
export const LIVE_KEEPALIVE_MS = 15_000;
export const LIVE_MAX_BUFFER = 1024 * 1024;
/** Spätestens nach so langer Pause ein tick (Herzschlag). */
export const LIVE_HEARTBEAT_MS = 1_000;

export interface LiveTapOptions {
  hz?: number;
  maxClients?: number;
  keepaliveMs?: number;
  maxBuffer?: number;
  now?: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}

interface SymTap {
  book: LiveBook;
  /** je Tag: Minuten davor sind beim letzten Durchgang abgeschlossen oder leer gewesen (ms) */
  scan: Map<number, number>;
  lastSentAt: number;
}

/** Grenze „in der Datenbank" laut Recorder (= data_day.live_until bzw. Ende des letzten finalen Tages). */
export function recorderCommittedTo(s: SymbolState): number | null {
  let c: number | null = s.lastCommittedMinute !== null ? s.lastCommittedMinute + MINUTE_MS : null;
  for (const di of s.days.values())
    if (di.skipBefore > 0 && (c === null || di.skipBefore > c)) c = di.skipBefore;
  if (s.final) {
    const end = (s.final.day + 1) * DAY_MS;
    if (c === null || end > c) c = end;
  }
  return c;
}

export class LiveTap {
  readonly hub: EventHub;
  private readonly rec: Recorder;
  private readonly syms = new Map<string, SymTap>();
  private readonly now: () => number;
  private readonly log: (msg: string, fields?: Record<string, unknown>) => void;
  private readonly periodMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Zähler (Health, Messung) */
  readonly stats = {
    errors: 0,
    lastError: null as string | null,
    messages: 0,
    bytes: 0,
    ticks: 0,
    commits: 0,
    snaps: 0,
    maxMsgBytes: 0,
  };
  private lastErrorLog = 0;

  constructor(rec: Recorder, o: LiveTapOptions = {}) {
    this.rec = rec;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    const hz = o.hz ?? LIVE_HZ_DEFAULT;
    this.periodMs = Math.max(50, Math.round(1000 / hz));
    this.hub = new EventHub(
      o.keepaliveMs ?? LIVE_KEEPALIVE_MS,
      o.maxClients ?? LIVE_MAX_CLIENTS,
      o.maxBuffer ?? LIVE_MAX_BUFFER,
    );
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.periodMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.hub.close();
  }

  get clients(): number {
    return this.hub.size;
  }

  /** GET /live: Kopfzeilen, dann je Symbol ein snap; danach alle Nachrichten. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    try {
      this.hub.attach(req, res, () => this.greeting());
    } catch (e) {
      this.fail(e);
      try {
        if (res.headersSent) res.destroy();
        else {
          res.writeHead(500);
          res.end();
        }
      } catch {
        /* Verbindung schon weg */
      }
    }
  }

  private greeting(): string {
    let out = ': ok\n\n';
    for (const name of this.rec.sym.keys()) {
      try {
        const st = this.ensure(name);
        if (!st) continue;
        const snap = st.book.snapshot(st.book.seq, this.now());
        out += `data: ${JSON.stringify(snap)}\n\n`;
        this.stats.snaps++;
      } catch (e) {
        this.fail(e);
      }
    }
    return out;
  }

  /** Ein Durchgang über alle Symbole (Timer). Wirft nie. */
  poll(): void {
    for (const name of this.rec.sym.keys()) {
      try {
        this.pollSym(name);
      } catch (e) {
        this.fail(e);
      }
    }
  }

  /** Minute `ms` ist festgeschrieben (Recorder.onMinuteCommitted). Wirft nie. */
  commit(symbol: string, ms: number): void {
    try {
      this.pollSym(symbol);
      const st = this.syms.get(symbol);
      if (!st) return;
      const committedTo = ms + MINUTE_MS;
      if (st.book.committedTo !== null && committedTo <= st.book.committedTo) return;
      this.emit(st, {
        v: LIVE_WIRE_VERSION,
        t: 'commit',
        sym: symbol,
        seq: st.book.seq + 1,
        serverMs: this.now(),
        ts: ms,
        committedTo,
      });
      this.stats.commits++;
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.stats.errors++;
    this.stats.lastError = e instanceof Error ? e.message : String(e);
    const now = this.now();
    if (now - this.lastErrorLog > 60_000) {
      this.lastErrorLog = now;
      this.log('live tap error', { error: this.stats.lastError, errors: this.stats.errors });
    }
  }

  private status(s: SymbolState): LiveStatus {
    const lastT = s.feed.lastT;
    const day = Math.floor((lastT > 0 ? lastT : this.now()) / DAY_MS);
    const gap = s.feed.gapOpen();
    return {
      recorder: true,
      stream: this.rec.stream?.connected ?? false,
      catchUp: gap,
      gapFrom: gap && lastT > 0 ? lastT : null,
      frozen: s.days.get(day)?.frozen ?? null,
      backlog: s.unwritten,
    };
  }

  private eventMs(s: SymbolState): number | null {
    return s.eventLagMs !== null && s.wsLastMsg > 0 ? s.wsLastMsg - s.eventLagMs : null;
  }

  /** Zustand eines Symbols anlegen (snap seq 0 mit der Grenze des Recorders, ohne Minuten). */
  private ensure(name: string): SymTap | null {
    let st = this.syms.get(name);
    if (st) return st;
    const s = this.rec.sym.get(name);
    if (!s) return null;
    const c = recorderCommittedTo(s);
    let first: number | null = null;
    for (const d of s.days.keys()) if (first === null || d < first) first = d;
    const from =
      c !== null
        ? c - LIVE_RETAIN_MS
        : first !== null
          ? first * DAY_MS
          : this.now() - LIVE_RETAIN_MS;
    st = { book: new LiveBook(name), scan: new Map(), lastSentAt: 0 };
    const r = st.book.apply({
      v: LIVE_WIRE_VERSION,
      t: 'snap',
      sym: name,
      seq: 0,
      serverMs: this.now(),
      committedTo: c,
      from: from - (from % MINUTE_MS),
      price: null,
      eventMs: this.eventMs(s),
      bars: [],
      status: this.status(s),
    });
    if (r !== 'ok') throw new Error(`live: snap nicht anwendbar (${r})`);
    this.syms.set(name, st);
    return st;
  }

  /** Geänderte Minuten seit dem letzten Durchgang (nur lesend). */
  private changedBars(s: SymbolState, st: SymTap): LiveBar[] {
    const book = st.book;
    const out: LiveBar[] = [];
    const push = (b: LiveBar) => {
      if (b.ts >= book.from && !sameBar(book.bars.get(b.ts), b)) out.push(b);
    };
    for (const [day, di] of s.days) {
      const dayStart = day * DAY_MS;
      if (di.frozen || dayStart + DAY_MS <= book.from) continue;
      const agg = di.live.agg;
      const cur = agg.currentMinute;
      if (cur < 0) continue;
      const scanFrom = Math.max(st.scan.get(day) ?? book.from, book.from, dayStart);
      for (let m = Math.ceil((scanFrom - dayStart) / MINUTE_MS); m <= cur; m++) {
        const b = agg.minuteBar(m);
        if (b) push(liveBarOf(b));
      }
      const ov = agg.openMinuteView();
      if (ov) push(liveBarOf(ov.bar));
      // Minuten vor cur sind abgeschlossen oder bleiben leer (der Aggregator nimmt keine späten Trades)
      st.scan.set(day, dayStart + cur * MINUTE_MS);
    }
    for (const d of st.scan.keys()) if (!s.days.has(d)) st.scan.delete(d);
    return out.sort((a, b) => a.ts - b.ts);
  }

  private pollSym(name: string): void {
    const s = this.rec.sym.get(name);
    if (!s) return;
    const st = this.ensure(name);
    if (!st) return;
    const now = this.now();
    const status = this.status(s);
    if (!sameStatus(status, st.book.status)) {
      this.emit(st, {
        v: LIVE_WIRE_VERSION,
        t: 'status',
        sym: name,
        seq: st.book.seq + 1,
        serverMs: now,
        status,
      });
    }
    const bars = this.changedBars(s, st);
    const eventMs = this.eventMs(s);
    if (bars.length === 0 && eventMs === st.book.eventMs && now - st.lastSentAt < LIVE_HEARTBEAT_MS)
      return;
    const last = bars.length ? bars[bars.length - 1]! : null;
    const latest = st.book.latest();
    const top = last && (!latest || last.ts >= latest.ts) ? last : latest;
    this.emit(st, {
      v: LIVE_WIRE_VERSION,
      t: 'tick',
      sym: name,
      seq: st.book.seq + 1,
      serverMs: now,
      price: top ? top.close : null,
      eventMs,
      bars,
    });
    this.stats.ticks++;
  }

  /** Nachricht auf den eigenen Stand anwenden, einmal serialisieren, an alle senden. */
  private emit(st: SymTap, m: LiveMsg): void {
    const r = st.book.apply(m);
    if (r !== 'ok') throw new Error(`live: eigene Nachricht nicht anwendbar (${r})`);
    st.lastSentAt = m.serverMs;
    const s = `data: ${JSON.stringify(m)}\n\n`;
    this.stats.messages++;
    this.stats.bytes += s.length;
    if (s.length > this.stats.maxMsgBytes) this.stats.maxMsgBytes = s.length;
    this.hub.broadcast(s);
  }
}
