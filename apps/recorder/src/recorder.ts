// Recorder (KONZEPT §2.1, §4.2, §4.3): WebSocket + REST-Nachholen → geordneter Feed je Symbol →
// Spool → LiveDay (dieselbe Rechnung wie der Import) → je abgeschlossener Minute eine Transaktion.
// Abhängigkeiten (REST, Socket, Schreiber, Uhr) sind injizierbar; die Tests ersetzen sie.
import {
  buildReconcileInput,
  DAY_MS,
  dayIndex,
  formatDay,
  getSymbol,
  LiveDay,
  MINUTE_MS,
  reconcileDay,
  type Kline,
  type MinuteDelta,
  type SymbolSpec,
} from '@orderflow/core';
import { RestError, toItem, type RestSource } from './binance.ts';
import { SymbolFeed, type FeedItem } from './feed.ts';
import type { LiveWriter, MinuteWriteResult, StoredFinal } from './livewriter.ts';
import { readSpoolDay, SpoolWriter } from './spool.ts';
import { StreamClient, type SocketFactory } from './ws.ts';

/** Schnittstelle des DB-Schreibers (LiveWriter oder Test-Double). */
export interface LiveSink {
  startState(spec: SymbolSpec): Promise<{
    final: StoredFinal | null;
    provisional: { day: number; state: string; liveUntil: number | null }[];
  }>;
  writeMinute(spec: SymbolSpec, d: MinuteDelta): Promise<MinuteWriteResult>;
  markGap(spec: SymbolSpec, fromMs: number, toMs: number): Promise<void>;
  writeKlineChecks(rows: Parameters<LiveWriter['writeKlineChecks']>[0]): Promise<void>;
}

export interface RecorderOptions {
  symbols: string[];
  wsUrl: string;
  socketFactory: SocketFactory;
  rest: RestSource;
  sink: LiveSink;
  spoolDir: string | null;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  /** Minute M gilt als abgeschlossen, wenn ein Trade mit T ≥ M + 60 000 + Marge vorliegt (§4.2: 2 s). */
  completionMarginMs?: number;
  /** Ruhiger Markt: REST-Probe frühestens so lange nach Minutenende, höchstens alle 30 s. */
  quietProbeMs?: number;
  onMinuteCommitted?: (symbol: string, minuteStartMs: number) => void;
  /** Kline-Abgleich der live geschriebenen Minuten (Standard an). */
  klineCheck?: boolean;
  /** Ausführung von Hintergrundschleifen (Tests: aus, dann `pump()` von Hand). */
  autoLoops?: boolean;
}

interface DayInfo {
  live: LiveDay;
  /** Minuten mit Start < diesem Zeitpunkt sind bereits in der DB (Neustart) → nicht erneut schreiben. */
  skipBefore: number;
  /** Tag wird nicht (mehr) geschrieben: nicht provisorisch oder nicht füllbare Lücke. */
  frozen: string | null;
  klines: Map<number, Kline>;
  checkedThrough: number;
  completeBefore: number;
}

export interface SymbolState {
  spec: SymbolSpec;
  feed: SymbolFeed;
  spool: SpoolWriter | null;
  days: Map<number, DayInfo>;
  final: StoredFinal | null;
  lastProbe: number;
  lastFallback: number;
  catchUpRows: number;
  gapsAbandoned: number;
  lastCommittedMinute: number | null;
  unwritten: number;
  wsLastMsg: number;
}

export class Recorder {
  readonly o: Required<Omit<RecorderOptions, 'onMinuteCommitted' | 'spoolDir'>> &
    Pick<RecorderOptions, 'onMinuteCommitted' | 'spoolDir'>;
  readonly sym = new Map<string, SymbolState>();
  stream: StreamClient | null = null;
  private queue: { spec: SymbolSpec; d: MinuteDelta }[] = [];
  private writing = false;
  private draining: Promise<void> | null = null;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  writeErrors = 0;

  constructor(o: RecorderOptions) {
    this.o = {
      now: Date.now,
      completionMarginMs: 2000,
      quietProbeMs: 5000,
      klineCheck: true,
      autoLoops: true,
      ...o,
    };
  }

  /** Startzustand aus DB und Spool herstellen, dann Stream und Schleifen starten. */
  async start(): Promise<void> {
    for (const name of this.o.symbols) {
      const spec = getSymbol(name);
      const st = await this.o.sink.startState(spec);
      const s: SymbolState = {
        spec,
        feed: new SymbolFeed(st.final?.lastAggId != null ? st.final.lastAggId + 1 : null),
        spool: this.o.spoolDir ? new SpoolWriter(this.o.spoolDir, name) : null,
        days: new Map(),
        final: st.final,
        lastProbe: 0,
        lastFallback: 0,
        catchUpRows: 0,
        gapsAbandoned: 0,
        lastCommittedMinute: null,
        unwritten: 0,
        wsLastMsg: 0,
      };
      this.sym.set(name, s);
      for (const p of st.provisional) {
        const di = this.ensureDay(s, p.day);
        if (di) {
          if (p.state !== 'provisional') di.frozen = `Zustand ${p.state}`;
          di.skipBefore = p.liveUntil ?? 0;
        }
      }
      // Neustart: Spool der Tage nach dem letzten finalen Tag wieder einspielen (ohne erneutes Spoolen)
      if (this.o.spoolDir && st.final) {
        const today = dayIndex(this.o.now());
        for (let d = st.final.day + 1; d <= today; d++) {
          const { items, truncatedFiles } = await readSpoolDay(this.o.spoolDir, name, d);
          if (items.length) {
            this.o.log('spool replay', {
              symbol: name,
              day: formatDay(d),
              rows: items.length,
              truncatedFiles,
            });
            this.handle(s, items, false);
          }
        }
      }
      this.o.log('start', {
        symbol: name,
        finalDay: st.final ? formatDay(st.final.day) : null,
        expectedAggId: s.feed.expected,
      });
    }
    const streams = this.o.symbols.map((x) => `${x.toLowerCase()}@aggTrade`).join('/');
    this.stream = new StreamClient({
      url: `${this.o.wsUrl}/stream?streams=${streams}`,
      factory: this.o.socketFactory,
      now: this.o.now,
      onMessage: (_stream, data) => this.onWs(data),
      onState: (c, info) => this.o.log('ws', { connected: c, info }),
    });
    this.stream.start();
    if (this.o.autoLoops) {
      for (const s of this.sym.values()) void this.catchUpLoop(s);
      this.timers.push(setInterval(() => void this.tick(), 1000));
      if (this.o.klineCheck) this.timers.push(setInterval(() => void this.klineCheckAll(), 60_000));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.stream?.stop();
    for (const s of this.sym.values()) s.spool?.close();
    // offene Schreibvorgänge abwarten
    for (let i = 0; i < 300 && (this.writing || this.queue.length); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private onWs(data: unknown): void {
    const m = data as {
      e?: string;
      s?: string;
      a: number;
      p: string;
      q: string;
      f: number;
      l: number;
      T: number;
      m: boolean;
    };
    if (m.e !== 'aggTrade' || !m.s) return;
    const s = this.sym.get(m.s);
    if (!s) return;
    s.wsLastMsg = this.o.now();
    let it: FeedItem;
    try {
      it = toItem(m, s.spec, false);
    } catch (e) {
      this.o.log('ws parse error', { symbol: m.s, error: String(e) });
      return;
    }
    this.handle(s, [it], true);
  }

  private ensureDay(s: SymbolState, day: number): DayInfo | null {
    if (s.final && day <= s.final.day) return null;
    let di = s.days.get(day);
    if (!di) {
      di = {
        live: new LiveDay(s.spec, day),
        skipBefore: 0,
        frozen: null,
        klines: new Map(),
        checkedThrough: 0,
        completeBefore: 0,
      };
      s.days.set(day, di);
    }
    return di;
  }

  /** Nachrichten in den Feed; lückenlose Folge spoolen, aggregieren, Minuten abschließen. */
  handle(s: SymbolState, items: FeedItem[], spool: boolean): void {
    const out = s.feed.push(items);
    if (out.length === 0) return;
    if (spool) s.spool?.append(out, this.o.now());
    for (const it of out) {
      const di = this.ensureDay(s, dayIndex(it.trade.T));
      if (!di || di.frozen) continue;
      try {
        di.live.add(it.trade, it.viaRest);
      } catch (e) {
        di.frozen = `Aggregationsfehler: ${String(e)}`;
        this.o.log('day frozen', {
          symbol: s.spec.name,
          day: formatDay(di.live.day),
          reason: di.frozen,
        });
      }
    }
    this.completeMinutes(s, s.feed.lastT);
  }

  /** Minuten abschließen, deren Ende + Marge ≤ `t` ist (t = letzter lückenloser Trade oder geprüfte Uhr). */
  completeMinutes(s: SymbolState, t: number): void {
    for (const [day, di] of s.days) {
      if (di.frozen) continue;
      const start = day * DAY_MS;
      const before = Math.max(
        0,
        Math.min(1440, Math.floor((t - this.o.completionMarginMs - start) / MINUTE_MS)),
      );
      if (before <= di.completeBefore) continue;
      di.completeBefore = before;
      for (const d of di.live.complete(before)) {
        if (start + d.minute * MINUTE_MS < di.skipBefore) continue;
        this.queue.push({ spec: s.spec, d });
        s.unwritten++;
      }
    }
    void this.drain();
  }

  /** Schreibwarteschlange abarbeiten (serielle Reihenfolge nach Zeit; DB-Ausfall → später erneut). */
  drain(): Promise<void> {
    if (this.draining) {
      // laufenden Durchgang abwarten, danach ggf. Nachzügler schreiben
      return this.draining.then(() => (this.queue.length > 0 ? this.drain() : undefined));
    }
    this.draining = this.drainOnce().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    this.writing = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue[0]!;
        const s = this.sym.get(job.spec.name)!;
        const di = s.days.get(job.d.day);
        if (di?.frozen) {
          this.queue.shift();
          s.unwritten--;
          continue;
        }
        let res: MinuteWriteResult;
        try {
          res = await this.o.sink.writeMinute(job.spec, job.d);
        } catch (e) {
          this.writeErrors++;
          this.o.log('db write failed, retry', { symbol: job.spec.name, error: String(e) });
          await new Promise((r) => setTimeout(r, 2000));
          if (this.stopped) return;
          continue;
        }
        this.queue.shift();
        s.unwritten--;
        if (res === 'not_provisional') {
          if (di) di.frozen = 'Tag nicht mehr provisional';
          this.o.log('day not provisional, stop writing', {
            symbol: job.spec.name,
            day: formatDay(job.d.day),
          });
          continue;
        }
        const ms = job.d.day * DAY_MS + job.d.minute * MINUTE_MS;
        s.lastCommittedMinute = ms;
        this.o.onMinuteCommitted?.(job.spec.name, ms);
      }
    } finally {
      this.writing = false;
    }
  }

  /** Lücken per REST schließen (fromId = erwartet), Seite für Seite, im Gewichtsbudget. */
  async catchUpLoop(s: SymbolState): Promise<void> {
    while (!this.stopped) {
      try {
        const moved = await this.catchUpOnce(s);
        if (!moved) await new Promise((r) => setTimeout(r, 250));
      } catch (e) {
        this.o.log('rest error', { symbol: s.spec.name, error: String(e) });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** Ein REST-Schritt; true, wenn etwas geholt wurde. Öffentlich für Tests. */
  async catchUpOnce(s: SymbolState): Promise<boolean> {
    const from = s.feed.expected;
    if (from === null) return false;
    // Ohne Stream (getrennt) holt REST weiter nach, aber höchstens alle 2 s, wenn nichts ansteht.
    const fallback = !s.feed.gapOpen() && this.stream !== null && !this.stream.connected;
    if (!s.feed.gapOpen() && !fallback) return false;
    if (fallback && this.o.now() - s.lastFallback < 2000) return false;
    if (fallback) s.lastFallback = this.o.now();
    let rows;
    try {
      rows = await this.o.rest.aggTrades(s.spec.name, from, 1000);
    } catch (e) {
      if (e instanceof RestError && e.status === 400) {
        // z. B. älter als 48 h: nicht füllbar → Lücke aufgeben, betroffene Tage einfrieren
        const gap = s.feed.abandonGap();
        if (gap) await this.abandon(s, gap, String(e));
        return true;
      }
      throw e;
    }
    if (rows.length === 0) return false;
    if (rows[0]!.a > from && s.feed.gapOpen()) s.feed.skipProvenMissing(rows[0]!.a);
    s.catchUpRows += rows.length;
    this.handle(
      s,
      rows.map((r) => toItem(r, s.spec, true)),
      true,
    );
    return true;
  }

  private async abandon(
    s: SymbolState,
    gap: { from: number; to: number },
    why: string,
  ): Promise<void> {
    s.gapsAbandoned++;
    const t0 = s.feed.lastT;
    this.o.log('gap not fillable', { symbol: s.spec.name, fromId: gap.from, toId: gap.to, why });
    // Der Tag mit der Lücke wird nicht weiter geschrieben (die offizielle Datei ersetzt ihn).
    const di = s.days.get(dayIndex(t0 || this.o.now()));
    if (di) di.frozen = `nicht füllbare Lücke ${gap.from}…${gap.to}`;
    await this.o.sink.markGap(s.spec, t0, this.o.now()).catch(() => {});
  }

  /** Sekündlich: ruhiger Markt (Uhr + REST-Probe), Spool-Flush. */
  async tick(): Promise<void> {
    const now = this.o.now();
    for (const s of this.sym.values()) {
      s.spool?.flush();
      if (s.feed.gapOpen() || s.feed.expected === null) continue;
      const lastT = s.feed.lastT;
      const openEnd = lastT - (lastT % MINUTE_MS) + MINUTE_MS;
      if (
        now >= openEnd + this.o.quietProbeMs &&
        lastT < openEnd + this.o.completionMarginMs &&
        now - s.lastProbe > 30_000
      ) {
        s.lastProbe = now;
        const rows = await this.o.rest.aggTrades(s.spec.name, s.feed.expected, 1).catch(() => null);
        if (rows && rows.length === 0) {
          // nichts Neueres: Minuten bis zur Uhr (minus Marge) sind abgeschlossen
          this.completeMinutes(s, now - 1000);
        } else if (rows) {
          this.handle(
            s,
            rows.map((r) => toItem(r, s.spec, true)),
            true,
          );
        }
      }
    }
  }

  /** Kline-Abgleich der abgeschlossenen Minuten (§4.6 auf dem Tag bis jetzt; nicht blockierend). */
  async klineCheckAll(): Promise<void> {
    for (const s of this.sym.values()) {
      for (const [day, di] of s.days) {
        if (di.frozen) continue;
        try {
          await this.klineCheck(s, day, di);
        } catch (e) {
          this.o.log('kline check failed', { symbol: s.spec.name, error: String(e) });
        }
      }
    }
  }

  async klineCheck(s: SymbolState, day: number, di: DayInfo): Promise<number> {
    const done = di.completeBefore;
    if (done === 0) return 0;
    // ab zwei Minuten vor dem zuletzt geprüften Stand erneut holen (Kompensation in der Folgeminute)
    const from = Math.max(0, di.checkedThrough - 2);
    if (from >= done) return 0;
    const limit = Math.min(99, done - from);
    const ks = await this.o.rest.klines(s.spec.name, day * DAY_MS + from * MINUTE_MS, limit);
    for (const k of ks) di.klines.set(k.openTime, k);
    const bars = di.live.completedBars();
    const cands = di.live.agg.candidates();
    const inp = buildReconcileInput(
      {
        day,
        trades: 0,
        fp1m: undefined as never,
        bars,
        candQ: cands.candQ,
        candB: cands.candB,
        candCount: cands.count,
        minStepUnits: 0,
      },
      [...di.klines.values()].sort((a, b) => a.openTime - b.openTime),
    );
    const prev =
      s.final && s.final.day === day - 1 && s.final.carry && s.final.cand
        ? { carry: s.final.carry, cand: s.final.cand }
        : undefined;
    const r = reconcileDay(inp, { prev, nextReconciled: false });
    const rows = [];
    const upto = Math.min(done, from + ks.length);
    for (let m = from; m < upto; m++) {
      const k = di.klines.get(day * DAY_MS + m * MINUTE_MS);
      if (!k) continue;
      rows.push({
        sym_id: s.spec.symId,
        ts: new Date(day * DAY_MS + m * MINUTE_MS),
        cls: r.ownCls[m]!,
        d_q: r.dQ[m]!,
        d_b: r.dB[m]!,
        s_q: r.sQ[m]!,
        s_b: r.sB[m]!,
        cand_q: inp.candQ[m]!,
        cand_b: inp.candB[m]!,
        kline_vol: k.vol,
        kline_taker: k.takerBuy,
        kline_trades: k.trades,
      });
    }
    await this.o.sink.writeKlineChecks(rows);
    di.checkedThrough = upto;
    return rows.length;
  }

  /** Tag d ist offiziell finalisiert: LiveDay freigeben, Kette auf d setzen. */
  markFinal(symbol: string, final: StoredFinal): void {
    const s = this.sym.get(symbol)!;
    s.final = final;
    for (const d of [...s.days.keys()]) if (d <= final.day) s.days.delete(d);
  }
}
