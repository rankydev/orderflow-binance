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
  parseDay,
  MINUTE_MS,
  reconcileDay,
  type Kline,
  type MinuteDelta,
  type SymbolSpec,
} from '@orderflow/core';
import { isTooOld, toItem, type RestSource } from './binance.ts';
import { SymbolFeed, type FeedItem } from './feed.ts';
import type { LiveWriter, MinuteWriteResult, StoredFinal } from './livewriter.ts';
import { pruneSpool, readSpoolDay, SpoolWriter } from './spool.ts';
import { StreamClient, type SocketFactory } from './ws.ts';

/** Schnittstelle des DB-Schreibers (LiveWriter oder Test-Double). */
export interface LiveSink {
  startState(spec: SymbolSpec): Promise<{
    final: StoredFinal | null;
    provisional: { day: number; state: string; liveUntil: number | null; frozen?: string | null }[];
    /** symbol.big_floor_n (Untergrenze big_order wie im Import; null = keine big orders). */
    bigFloorN: number | null;
  }>;
  writeMinute(spec: SymbolSpec, d: MinuteDelta): Promise<MinuteWriteResult>;
  markGap(spec: SymbolSpec, fromMs: number, toMs: number): Promise<void>;
  /** Tag wird nicht weiter live geschrieben: Grund für Leser sichtbar machen (data_day.live_frozen). */
  markFrozen(spec: SymbolSpec, day: number, reason: string): Promise<void>;
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
  /** Freier Platz des Spool-Verzeichnisses (Bytes); darunter wird nicht mehr gespoolt (DB-Schreiben läuft weiter). */
  freeBytes?: (() => number) | null;
  minFreeBytes?: number;
  /** Spool-Tage länger als so viele Tage vor heute werden gelöscht – unabhängig von der Finalisierung. */
  spoolKeepDays?: number;
  /** Schreibversuche einer Minute bei dauerhaftem Fehler, bevor der Tag eingefroren wird. */
  maxPermanentFailures?: number;
}

/** Maximale Länge einer als `gap` vermerkten Lücke (REST-Fenster 48 h + Reserve). */
export const MAX_GAP_MS = 3 * DAY_MS;

/**
 * Vorübergehender DB-Fehler (Verbindung, Überlast, Abbruch, Deadlock, Sperrzeit) → später erneut;
 * alles andere (Daten-, Constraint-, Syntaxfehler, Programmfehler) gilt als dauerhaft.
 */
export function isTransientDbError(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? '');
  // 57014 (statement_timeout): eine Minute, die das Limit immer überschreitet, würde sonst ewig
  // wiederholt und blockierte die Warteschlange – zählt als dauerhafter Fehler (nach N Versuchen
  // eingefroren); ein einmaliger Lastspitzen-Timeout ist nach dem nächsten Versuch erledigt.
  if (code === '57014') return false;
  if (/^(08|53|57|40)/.test(code) || code === '55P03') return true;
  if (/^(CONNECTION_|CONNECT_TIMEOUT|ECONN|ETIMEDOUT|EPIPE|ENOTFOUND|EHOSTUNREACH)/.test(code))
    return true;
  return false;
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
  /** Untergrenze big_order beim Start (symbol.big_floor_n). */
  bigFloorN: number | null;
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
  /** Uhrzeit minus Ereigniszeit E der letzten Stream-Nachricht (Uhrversatz + Latenz). */
  eventLagMs: number | null;
  /** Fortlaufend fehlschlagendes Nachholen (Review S1/S1a): Fehler an derselben fromId; key = letzter. */
  restFail: { fromId: number | null; key: string; count: number; since: number } | null;
  /** gesetzt, solange das Nachholen dauerhaft scheitert (Health/Alarm); null sonst */
  restAlert: string | null;
}

/** Ab so vielen Fehlern an derselben fromId oder so lange gilt das Nachholen als gestört. */
export const REST_ALERT_FAILURES = 12;
export const REST_ALERT_MS = 15 * 60_000;

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
  /** Spoolen aktiv (false unterhalb der Plattengrenze). */
  spoolEnabled = true;
  freeSpoolBytes: number | null = null;
  spoolPruned: string[] = [];
  private attempts = new Map<string, number>();
  private lastDiskCheck = 0;
  private lastRetention = 0;

  constructor(o: RecorderOptions) {
    this.o = {
      now: Date.now,
      completionMarginMs: 2000,
      quietProbeMs: 5000,
      klineCheck: true,
      autoLoops: true,
      freeBytes: null,
      minFreeBytes: 5 * 1024 ** 3,
      spoolKeepDays: 7,
      maxPermanentFailures: 5,
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
        bigFloorN: st.bigFloorN,
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
        eventLagMs: null,
        restFail: null,
        restAlert: null,
      };
      this.sym.set(name, s);
      for (const p of st.provisional) {
        const di = this.ensureDay(s, p.day);
        if (di) {
          if (p.state !== 'provisional') di.frozen = `Zustand ${p.state}`;
          else if (p.frozen) di.frozen = p.frozen; // eingefroren bleibt eingefroren (Neustart)
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
    const E = (data as { E?: number }).E;
    if (typeof E === 'number') s.eventLagMs = s.wsLastMsg - E;
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
        live: new LiveDay(s.spec, day, s.bigFloorN),
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

  /**
   * Tag nicht mehr live schreiben (die offizielle Datei ersetzt ihn später) und den Grund in der
   * DB sichtbar machen. Bereits finale Tage bleiben unberührt.
   */
  freeze(s: SymbolState, day: number, reason: string): void {
    const di = this.ensureDay(s, day);
    if (!di || di.frozen) return;
    di.frozen = reason;
    this.o.log('day frozen', { symbol: s.spec.name, day: formatDay(day), reason });
    this.o.sink
      .markFrozen(s.spec, day, reason)
      .catch((e: unknown) =>
        this.o.log('mark frozen failed', { symbol: s.spec.name, error: String(e) }),
      );
  }

  /** Nachrichten in den Feed; lückenlose Folge spoolen, aggregieren, Minuten abschließen. */
  handle(s: SymbolState, items: FeedItem[], spool: boolean): void {
    const out = s.feed.push(items);
    if (out.length === 0) return;
    if (spool && this.spoolEnabled) s.spool?.append(out, this.o.now());
    for (const it of out) {
      const di = this.ensureDay(s, dayIndex(it.trade.T));
      if (!di || di.frozen) continue;
      try {
        di.live.add(it.trade, it.viaRest);
      } catch (e) {
        this.freeze(s, di.live.day, `Aggregationsfehler: ${String(e)}`);
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
        const key = `${job.spec.name}|${job.d.day}|${job.d.minute}`;
        try {
          res = await this.o.sink.writeMinute(job.spec, job.d);
        } catch (e) {
          this.writeErrors++;
          if (isTransientDbError(e)) {
            this.o.log('db write failed (transient), retry', {
              symbol: job.spec.name,
              error: String(e),
            });
          } else {
            const n = (this.attempts.get(key) ?? 0) + 1;
            this.attempts.set(key, n);
            this.o.log('db write failed (permanent)', {
              symbol: job.spec.name,
              attempt: n,
              error: String(e),
            });
            if (n >= this.o.maxPermanentFailures) {
              // eine dauerhaft scheiternde Minute darf nicht alle folgenden blockieren
              this.queue.shift();
              s.unwritten--;
              this.attempts.delete(key);
              this.freeze(s, job.d.day, `Schreibfehler Minute ${job.d.minute}: ${String(e)}`);
              continue;
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
          if (this.stopped) return;
          continue;
        }
        this.attempts.delete(key);
        this.queue.shift();
        s.unwritten--;
        if (res === 'not_provisional') {
          this.freeze(s, job.d.day, 'Tag nicht mehr provisional');
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
      const r = await this.catchUpStep(s);
      if (r === 'error') await new Promise((x) => setTimeout(x, 5000));
      else if (r === 'idle') await new Promise((x) => setTimeout(x, 250));
    }
  }

  /**
   * Ein Nachhol-Schritt mit Fehlerbuchführung (Review S1): jeder Fehler außer -4166 wird weiter
   * versucht (Aufgeben kostete Daten), aber jeder Fehler an derselben fromId zählt (auch wechselnde, S1a); ab
   * REST_ALERT_FAILURES Versuchen oder REST_ALERT_MS setzt er restAlert (Health), bis ein Schritt
   * wieder gelingt.
   */
  async catchUpStep(s: SymbolState): Promise<'moved' | 'idle' | 'error'> {
    try {
      const moved = await this.catchUpOnce(s);
      if (s.restFail || s.restAlert) {
        if (s.restAlert) this.o.log('rest catch-up recovered', { symbol: s.spec.name });
        s.restFail = null;
        s.restAlert = null;
      }
      return moved ? 'moved' : 'idle';
    } catch (e) {
      const now = this.o.now();
      const code = (e as { code?: unknown }).code;
      const key = `${String(code ?? '')} ${e instanceof Error ? e.message : String(e)}`.trim();
      const from = s.feed.expected;
      // je fromId zählen (Review S1a): wechselnde Fehler an derselben Stelle (ECONNRESET,
      // Zeitüberschreitung, 502) sind dasselbe Steckenbleiben; `since` bleibt beim ersten Fehler
      if (s.restFail && s.restFail.fromId === from) {
        s.restFail.count++;
        s.restFail.key = key;
      } else s.restFail = { fromId: from, key, count: 1, since: now };
      this.o.log('rest error', { symbol: s.spec.name, error: String(e), count: s.restFail.count });
      if (
        !s.restAlert &&
        (s.restFail.count >= REST_ALERT_FAILURES || now - s.restFail.since >= REST_ALERT_MS)
      ) {
        s.restAlert = `REST catch-up failing persistently: ${key} (fromId ${String(from)}, ${s.restFail.count}× seit ${new Date(s.restFail.since).toISOString()})`;
        this.o.log('REST CATCH-UP ALERT', { symbol: s.spec.name, reason: s.restAlert });
      }
      return 'error';
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
      // Nur Binances „Suchfenster überschritten" (-4166) heißt: nicht mehr füllbar. Jeder andere
      // Fehler (auch ein anderer 400) ist ein gewöhnlicher Fehler: catchUpLoop versucht es erneut.
      if (isTooOld(e)) {
        // älter als 48 h. Liegt der Anfang vor heute: ab dem ersten Trade des heutigen Tages
        // weiter nachholen (heute wird vollständig), nur die Tage davor gelten als Lücke. Sonst (oder
        // wenn der Tagesanfang nicht bestimmbar ist) Lücke aufgeben, betroffene Tage einfrieren.
        if (await this.skipToToday(s, String(e))) return true;
        await this.abandonGapNow(s, String(e));
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

  /**
   * Sicherheitsnetz für den ersten Start mit altem letzten finalen Tag (Review): der Teil der Lücke
   * vor dem heutigen Tag liegt außerhalb des REST-Fensters. Erste ID von heute per startTime
   * bestimmen, dorthin springen und ab dort per fromId nachholen; nur die Tage davor (höchstens
   * MAX_GAP_MS) einfrieren und als Lücke vermerken. Normalweg bleibt: Importer bis gestern vor dem
   * Start (RUNBOOK).
   */
  async skipToToday(s: SymbolState, why: string): Promise<boolean> {
    const rest = this.o.rest;
    if (!rest.aggTradesByTime) return false;
    const now = this.o.now();
    const today0 = now - (now % DAY_MS);
    let fromMs = s.feed.lastT > 0 ? s.feed.lastT : s.final ? (s.final.day + 1) * DAY_MS : today0;
    if (fromMs >= today0) return false;
    const first = await rest
      .aggTradesByTime(s.spec.name, today0, today0 + 3_600_000 - 1, 1)
      .catch(() => null);
    const id = first?.[0]?.a;
    if (id === undefined) return false;
    const gap = s.feed.jumpTo(id);
    if (!gap) return false;
    s.gapsAbandoned++;
    if (today0 - fromMs > MAX_GAP_MS) fromMs = today0 - MAX_GAP_MS;
    this.o.log('gap before today not fillable, catching up today from its first trade', {
      symbol: s.spec.name,
      fromId: gap.from,
      toId: gap.to,
      todayFirstId: id,
      fromMs,
      toMs: today0,
      why,
    });
    for (let d = dayIndex(fromMs); d < dayIndex(today0); d++) {
      this.freeze(s, d, `nicht füllbare Lücke aggId ${gap.from}…${gap.to} (vor heute)`);
    }
    // Ende exklusiv: alle übersprungenen IDs liegen vor today0 (die erste ID von heute ist die
    // erste mit T >= today0); Minute 00:00 schreibt der Recorder vollständig.
    await this.o.sink
      .markGap(s.spec, fromMs, today0 - 1)
      .catch((e: unknown) =>
        this.o.log('mark gap failed', { symbol: s.spec.name, error: String(e) }),
      );
    return true;
  }

  /**
   * Nicht füllbare Lücke (REST-Fenster überschritten). Grenzen aus den Trades: von T des letzten
   * ausgegebenen Trades (sonst Ende des letzten finalen Tages) bis T des ersten Trades nach der
   * Lücke; höchstens MAX_GAP_MS. Jeder berührte Tag wird eingefroren (auch der Tag nach Mitternacht,
   * dem die Trades vor der Lücke fehlen) und die Minuten der Lücke als `gap` vermerkt.
   */
  async abandonGapNow(
    s: SymbolState,
    why: string,
  ): Promise<{ fromMs: number; toMs: number } | null> {
    const after = s.feed.firstBuffered();
    const gap = s.feed.abandonGap();
    if (!gap) return null;
    s.gapsAbandoned++;
    const toMs = after ? after.trade.T : this.o.now();
    let fromMs =
      s.feed.lastT > 0
        ? s.feed.lastT
        : s.final
          ? (s.final.day + 1) * DAY_MS
          : toMs - (toMs % DAY_MS);
    if (toMs - fromMs > MAX_GAP_MS) {
      this.o.log('gap longer than bound, truncated', { symbol: s.spec.name, fromMs, toMs });
      fromMs = toMs - MAX_GAP_MS;
    }
    this.o.log('gap not fillable', {
      symbol: s.spec.name,
      fromId: gap.from,
      toId: gap.to,
      fromMs,
      toMs,
      why,
    });
    for (let d = dayIndex(fromMs); d <= dayIndex(toMs); d++) {
      this.freeze(s, d, `nicht füllbare Lücke aggId ${gap.from}…${gap.to}`);
    }
    await this.o.sink
      .markGap(s.spec, fromMs, toMs)
      .catch((e: unknown) =>
        this.o.log('mark gap failed', { symbol: s.spec.name, error: String(e) }),
      );
    return { fromMs, toMs };
  }

  /** Sekündlich: ruhiger Markt (Uhr + REST-Probe), Spool-Flush. */
  async tick(): Promise<void> {
    const now = this.o.now();
    this.diskAndRetention(now);
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

  /**
   * Plattenwächter (alle 10 s) und Spool-Aufbewahrung (stündlich, unabhängig von der Finalisierung):
   * unterhalb von minFreeBytes wird nicht mehr gespoolt (Minuten werden weiter geschrieben; nach einem
   * Absturz holt REST nach), oberhalb von 1,2 × wieder.
   */
  diskAndRetention(now: number): void {
    if (this.o.freeBytes && now - this.lastDiskCheck >= 10_000) {
      this.lastDiskCheck = now;
      const free = this.o.freeBytes();
      this.freeSpoolBytes = free;
      if (this.spoolEnabled && free < this.o.minFreeBytes) {
        this.spoolEnabled = false;
        for (const s of this.sym.values()) s.spool?.flush();
        this.o.log('low disk: spooling stopped', { freeBytes: free });
      } else if (!this.spoolEnabled && free > this.o.minFreeBytes * 1.2) {
        this.spoolEnabled = true;
        this.o.log('disk ok: spooling resumed', { freeBytes: free });
      }
    }
    if (this.o.spoolDir && now - this.lastRetention >= 3600_000) {
      this.lastRetention = now;
      const oldest = dayIndex(now) - this.o.spoolKeepDays;
      for (const name of this.sym.keys()) {
        const gone = pruneSpool(this.o.spoolDir, name, (d) => parseDay(d) >= oldest);
        if (gone.length) {
          this.spoolPruned.push(...gone.map((d) => `${name} ${d}`));
          this.o.log('spool pruned', { symbol: name, days: gone });
        }
      }
    }
  }

  /** Länge der Schreibwarteschlange (Tests, Health). */
  queueLength(): number {
    return this.queue.length;
  }

  /** Eingefrorene Tage je Symbol (für Health/Monitor). */
  frozenDays(s: SymbolState): { day: string; reason: string }[] {
    return [...s.days.entries()]
      .filter(([, di]) => di.frozen)
      .map(([d, di]) => ({ day: formatDay(d), reason: di.frozen! }));
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
      { day, bars, candQ: cands.candQ, candB: cands.candB },
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
