// Recorder-Daemon (KONZEPT §2.1, §2.5, §4.2, §4.3). Aufruf aus dem Repo-Wurzelverzeichnis:
//   node --env-file-if-exists=.env apps/recorder/src/main.ts run
//   node --env-file-if-exists=.env apps/recorder/src/main.ts replay --symbol BTCUSDT --day 2026-11-21 [--db]
// Konfiguration über Umgebungsvariablen (OF_DB_* wie überall, dazu):
//   OF_RECORDER_SYMBOLS      Symbole, Komma-getrennt (Standard BTCUSDT,ETHUSDT)
//   OF_SPOOL_DIR             Spool-Verzeichnis (Standard <OF_DATA_DIR>/live, §3.1)
//   OF_SPOOL_KEEP_DAYS       Spool-Tage nach Finalisierung behalten (Standard 7)
//   OF_SPOOL_MIN_FREE_GB     Unter diesem freien Platz meldet Health „unhealthy" (Standard 5)
//   OF_REST_WEIGHT_PER_MIN   eigenes REST-Gewichtsbudget (Standard 1200 = 50 % von 2400, §4.2)
//   OF_BINANCE_WS_BASE / OF_BINANCE_REST_BASE   Endpunkte (Standard Binance USDⓈ-M, /market)
//   OF_RECORDER_HTTP_PORT    lokaler Health-/Ereignis-Port auf 127.0.0.1 (Standard 7701, 0 = aus)
//   OF_RECORDER_FINALISE     tägliche Finalisierung im Prozess (Standard 1)
import { DAY_MS, dayIndex, formatDay, getSymbol, parseConfig, parseDay } from '@orderflow/core';
import { execFile } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { BinanceRest, DEFAULT_REST_BASE, DEFAULT_WS_BASE, WeightBudget } from './binance.ts';
import { finaliseDay, nextAttempt } from './finalize.ts';
import { LiveWriter } from './livewriter.ts';
import { Recorder } from './recorder.ts';
import { replayDay } from './replay.ts';
import { freeBytes, pruneSpool } from './spool.ts';
import type { SocketLike } from './ws.ts';

type Env = Record<string, string | undefined>;

export interface RecorderConfig {
  symbols: string[];
  spoolDir: string;
  dataDir: string;
  keepDays: number;
  minFreeBytes: number;
  weightPerMin: number;
  wsBase: string;
  restBase: string;
  httpPort: number;
  finalise: boolean;
}

export function recorderConfig(env: Env): RecorderConfig {
  const dataDir = env.OF_DATA_DIR ?? 'data';
  const num = (k: string, d: number) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${k} ist keine nichtnegative Zahl: "${v}"`);
    return n;
  };
  const symbols = (env.OF_RECORDER_SYMBOLS ?? 'BTCUSDT,ETHUSDT')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const s of symbols) getSymbol(s);
  const weightPerMin = num('OF_REST_WEIGHT_PER_MIN', 1200);
  if (weightPerMin > 2400) throw new Error('OF_REST_WEIGHT_PER_MIN über dem IP-Limit 2400');
  return {
    symbols,
    dataDir,
    spoolDir: env.OF_SPOOL_DIR ?? join(dataDir, 'live'),
    keepDays: num('OF_SPOOL_KEEP_DAYS', 7),
    minFreeBytes: num('OF_SPOOL_MIN_FREE_GB', 5) * 1024 ** 3,
    weightPerMin,
    wsBase: env.OF_BINANCE_WS_BASE ?? DEFAULT_WS_BASE,
    restBase: env.OF_BINANCE_REST_BASE ?? DEFAULT_REST_BASE,
    httpPort: num('OF_RECORDER_HTTP_PORT', 7701),
    finalise: (env.OF_RECORDER_FINALISE ?? '1') !== '0',
  };
}

/** Strukturierte Logzeile (JSON, eine Zeile, keine Secrets). */
export function logLine(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), c: 'recorder', msg, ...fields }));
}

/** systemd sd_notify über `systemd-notify` (NotifyAccess=all nötig); ohne NOTIFY_SOCKET ein No-op. */
export function sdNotify(state: string): void {
  if (!process.env.NOTIFY_SOCKET) return;
  execFile('systemd-notify', [`--pid=${process.pid}`, state], () => {});
}

async function run(): Promise<number> {
  const cfg = recorderConfig(process.env);
  const db = parseConfig(process.env).db;
  const writer = new LiveWriter(db, (s) => logLine(s));
  await writer.open();
  const rest = new BinanceRest(cfg.restBase, new WeightBudget(cfg.weightPerMin), getSymbol);
  const clients = new Set<ServerResponse>();
  const rec = new Recorder({
    symbols: cfg.symbols,
    wsUrl: cfg.wsBase,
    socketFactory: (url) => new WebSocket(url) as unknown as SocketLike,
    rest,
    sink: writer,
    spoolDir: cfg.spoolDir,
    log: logLine,
    onMinuteCommitted: (symbol, ms) => {
      // lokaler Ereignis-Feed für die API (§4.2 „Minute M committed")
      const ev = `event: minute\ndata: ${JSON.stringify({ symbol, ts: ms })}\n\n`;
      for (const c of clients) c.write(ev);
    },
  });
  await rec.start();
  let lastFinalised: Record<string, string | null> = {};
  const attempts = new Map<string, number>();
  const health = () => {
    const now = Date.now();
    const free = freeBytes(cfg.spoolDir);
    const symbols = Object.fromEntries(
      [...rec.sym.entries()].map(([name, s]) => [
        name,
        {
          lastTradeAgeMs: s.feed.lastT ? now - s.feed.lastT : null,
          lastWsMessageAgeMs: s.wsLastMsg ? now - s.wsLastMsg : null,
          expectedAggId: s.feed.expected,
          gapOpen: s.feed.gapOpen(),
          buffered: s.feed.stats.buffered,
          catchUpRows: s.catchUpRows,
          duplicates: s.feed.stats.duplicates,
          jumps: s.feed.stats.jumps,
          provenMissing: s.feed.stats.provenMissing,
          gapsAbandoned: s.gapsAbandoned,
          unwrittenMinutes: s.unwritten,
          lastCommittedMinute: s.lastCommittedMinute
            ? new Date(s.lastCommittedMinute).toISOString()
            : null,
          spoolLagMs: s.spool?.oldestUnflushed ? now - s.spool.oldestUnflushed : 0,
          lastFinalisedDay: lastFinalised[name] ?? null,
        },
      ]),
    );
    const fresh = Object.values(symbols).every(
      (x) => x.lastTradeAgeMs !== null && x.lastTradeAgeMs < 120_000,
    );
    return {
      healthy: fresh && free >= cfg.minFreeBytes && rec.stream?.connected === true,
      wsConnected: rec.stream?.connected ?? false,
      wsReconnects: rec.stream?.reconnects ?? 0,
      wsRotations: rec.stream?.rotations ?? 0,
      restRequests: rest.requests,
      restWeight: rest.weight,
      restWeightUsed1m: rest.budget.serverUsed,
      dbWrites: writer.writes,
      dbWriteMsAvg: writer.writes ? Math.round(writer.writeMsTotal / writer.writes) : null,
      dbWriteMsMax: Math.round(writer.writeMsMax),
      dbWriteErrors: rec.writeErrors,
      freeSpoolBytes: free,
      rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
      symbols,
    };
  };
  const server =
    cfg.httpPort > 0
      ? createServer((req, res) => {
          if (req.url === '/health') {
            const h = health();
            res.writeHead(h.healthy ? 200 : 503, { 'content-type': 'application/json' });
            res.end(JSON.stringify(h));
          } else if (req.url === '/events') {
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
            });
            clients.add(res);
            req.on('close', () => clients.delete(res));
          } else {
            res.writeHead(404).end();
          }
        }).listen(cfg.httpPort, '127.0.0.1')
      : null;
  sdNotify('READY=1');
  const status = setInterval(() => {
    const h = health();
    for (const [name, s] of rec.sym) {
      const x = h.symbols[name]!;
      void writer
        .writeStatus({
          sym_id: s.spec.symId,
          last_agg_id: s.feed.expected !== null ? s.feed.expected - 1 : null,
          last_trade_ms: s.feed.lastT || null,
          ws_connected: h.wsConnected,
          open_gaps: s.feed.gapOpen() ? 1 : 0,
          unwritten_minutes: s.unwritten,
          rest_weight_1m: h.restWeightUsed1m,
          spool_lag_ms: x.spoolLagMs,
          last_committed_minute: s.lastCommittedMinute ? new Date(s.lastCommittedMinute) : null,
          last_finalised_day: lastFinalised[name] ?? null,
          details: x,
        })
        .catch((e: unknown) => logLine('status write failed', { error: String(e) }));
    }
    // Watchdog nur bei frischen Daten (§2.5: letzter Trade < 30 s)
    if (
      Object.values(h.symbols).every((x) => x.lastTradeAgeMs !== null && x.lastTradeAgeMs < 30_000)
    ) {
      sdNotify('WATCHDOG=1');
    }
    if (h.freeSpoolBytes < cfg.minFreeBytes) logLine('low disk', { freeBytes: h.freeSpoolBytes });
  }, 10_000);
  const statsLog = setInterval(() => logLine('stats', health()), 60_000);
  // tägliche Finalisierung: Tage vor heute, die noch nicht final sind, ab 06:00 UTC des Folgetags
  const fin = setInterval(async () => {
    if (!cfg.finalise) return;
    const now = Date.now();
    for (const [name, s] of rec.sym) {
      const today = dayIndex(now);
      const from = s.final ? s.final.day + 1 : today - 1;
      for (let d = from; d < today; d++) {
        const key = `${name}|${d}`;
        const at = nextAttempt(d, now, attempts.get(key) ?? null, 15 * 60_000);
        if (now < at) break;
        // erst nach dem letzten geschriebenen Tagesende (+ Marge) des Recorders
        const di = s.days.get(d);
        if (di && !di.frozen && di.completeBefore < 1440) break;
        attempts.set(key, now);
        try {
          const r = await finaliseDay({
            dataDir: cfg.dataDir,
            cfg: db,
            spec: s.spec,
            day: d,
            sql: writer.db,
            log: (m) => logLine(m),
          });
          if (r === 'not_available' || r === 'lock_busy') {
            logLine('finalise later', { symbol: name, day: formatDay(d), reason: r });
            break;
          }
          const st = await writer.startState(s.spec);
          if (st.final) rec.markFinal(name, st.final);
          lastFinalised = { ...lastFinalised, [name]: formatDay(d) };
          logLine('finalised', { symbol: name, day: formatDay(d) });
          pruneSpool(cfg.spoolDir, name, (day) => parseDay(day) > d - cfg.keepDays);
        } catch (e) {
          logLine('finalise failed', { symbol: name, day: formatDay(d), error: String(e) });
          break;
        }
      }
    }
  }, 60_000);
  void DAY_MS;
  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      logLine('shutdown', { signal: sig });
      sdNotify('STOPPING=1');
      resolve();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
  clearInterval(status);
  clearInterval(statsLog);
  clearInterval(fin);
  await rec.stop();
  server?.close();
  for (const c of clients) c.end();
  await writer.close();
  logLine('stopped', health());
  return 0;
}

async function replay(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      symbol: { type: 'string' },
      day: { type: 'string' },
      db: { type: 'boolean' },
      'data-dir': { type: 'string' },
    },
  });
  if (!v.symbol || !v.day) throw new Error('replay --symbol S --day YYYY-MM-DD [--db]');
  const r = await replayDay({
    dataDir: v['data-dir'] ?? process.env.OF_DATA_DIR ?? 'data',
    symbol: v.symbol,
    day: parseDay(v.day),
    db: v.db ? parseConfig(process.env).db : null,
    log: logLine,
  });
  logLine('replay result', r as unknown as Record<string, unknown>);
  return r.equal ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'run') return run();
  if (cmd === 'replay') return replay(rest);
  console.error('Verwendung: main.ts run | replay --symbol S --day D [--db]');
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c;
    },
    (e: unknown) => {
      logLine('fatal', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      process.exitCode = 1;
    },
  );
}
