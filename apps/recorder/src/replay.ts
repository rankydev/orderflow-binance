// Replay-Harness (Korrektheitsanker des Live-Pfads): speist einen echten Tag aus der offiziellen
// Tagesdatei durch den echten Recorder-Pfad (Feed mit Störungen: Umordnung, Duplikate, Lücken,
// die nur REST schließt → LiveDay → Minuten-Deltas) und vergleicht das Ergebnis mit dem Import
// desselben Tages: im Speicher über die Digests aller Tabellen, mit `db` zusätzlich nach dem
// Schreiben in die Datenbank (minutenweise und je Tabelle per day_digest).
import {
  barDigest,
  buildDayData,
  dayIndex,
  DAY_MS,
  formatDay,
  FP_TABLES,
  fpDigest,
  getSymbol,
  parseAggTradeRange,
  SOURCE_VISION,
  type AggTrade,
  type DbConfig,
  type MinuteDelta,
} from '@orderflow/core';
import {
  absPath,
  isPresent,
  klineRef,
  readAggTrades,
  readKlineDay,
  streamSingleEntry,
  textBlocks,
  verifyFile,
} from '@orderflow/importer';
import { toItem, type RawAgg, type RestSource } from './binance.ts';
import { compareLiveDay, type QualityResult } from './finalize.ts';
import { LiveWriter } from './livewriter.ts';
import { Recorder, type LiveSink } from './recorder.ts';
import type { SocketLike } from './ws.ts';

export interface ReplayResult {
  symbol: string;
  day: string;
  rows: number;
  minutes: number;
  restRequests: number;
  duplicatesInjected: number;
  gapsInjected: number;
  equal: boolean;
  tables: Record<string, boolean>;
  db: QualityResult | null;
  ms: number;
}

/** Zeilen einer aggTrades-Tagesdatei als REST-ähnliche Rohdatensätze (Originalstrings). */
async function readRaw(path: string, spec: ReturnType<typeof getSymbol>): Promise<RawAgg[]> {
  const out: RawAgg[] = [];
  const t: AggTrade = { a: 0, px: 0, q: 0, f: 0, l: 0, T: 0, m: false };
  let first = true;
  for await (const { text, lineEnd } of textBlocks(streamSingleEntry(path))) {
    let p = 0;
    while (p < lineEnd) {
      const nl = text.indexOf('\n', p);
      const e = nl > p && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      if (e > p) {
        if (first && text.startsWith('agg_trade_id', p)) {
          first = false;
          p = nl + 1;
          continue;
        }
        first = false;
        parseAggTradeRange(text, p, e, spec, t);
        const f = text.slice(p, e).split(',');
        out.push({ a: t.a, p: f[1]!, q: f[2]!, f: t.f, l: t.l, T: t.T, m: t.m });
      }
      p = nl + 1;
    }
  }
  return out;
}

export async function replayDay(o: {
  dataDir: string;
  symbol: string;
  day: number;
  /** Datenbank für den Schreibtest (Test-Datenbank verwenden; der Tag wird dort ersetzt). */
  db: DbConfig | null;
  log: (msg: string, f?: Record<string, unknown>) => void;
}): Promise<ReplayResult> {
  const t0 = performance.now();
  const spec = getSymbol(o.symbol);
  const ds = formatDay(o.day);
  const aggPath = absPath(o.dataDir, {
    kind: 'aggTrades',
    origin: 'daily',
    symbol: o.symbol,
    period: ds,
  });
  const klPath = absPath(o.dataDir, klineRef(o.symbol, o.day));
  if (!isPresent(aggPath) || !isPresent(klPath))
    throw new Error(`Tagesdateien für ${o.symbol} ${ds} fehlen`);
  await verifyFile(aggPath);
  const raw = await readRaw(aggPath, spec);
  // Referenz: der Importer-Weg
  let agg;
  await readAggTrades(aggPath, spec, {
    firstDay: o.day,
    lastDay: o.day,
    want: () => true,
    onDay: (c) => {
      agg = c.agg;
    },
  });
  const kl = await readKlineDay(klPath, spec, o.day);
  const ref = buildDayData(spec, agg!, kl.klines);

  // Live-Weg: Fake-REST über die Dateizeilen (fromId-Seiten), Fake-Socket ohne Nachrichten
  const byId = new Map<number, number>();
  raw.forEach((r, i) => byId.set(r.a, i));
  let restRequests = 0;
  const rest: RestSource = {
    async aggTrades(_s, fromId, limit) {
      restRequests++;
      let i = byId.get(fromId);
      if (i === undefined) i = raw.findIndex((r) => r.a >= fromId);
      if (i < 0) return [];
      return raw.slice(i, i + limit);
    },
    async klines() {
      return [];
    },
  };
  const deltas: MinuteDelta[] = [];
  let writer: LiveWriter | null = null;
  let sink: LiveSink;
  if (o.db) {
    writer = new LiveWriter(o.db);
    await writer.open();
    await writer.ensureSymbol(spec);
    // Tag in der (Test-)DB vorher entfernen; data_day des Vortags als finale Kette setzen
    for (const t of [...FP_TABLES, 'bar_1m', 'bar_1h', 'bar_1d', 'data_minute_issue']) {
      await writer.db.unsafe(`DELETE FROM ${t} WHERE sym_id = $1 AND ts >= $2 AND ts < $3`, [
        spec.symId,
        new Date(o.day * DAY_MS),
        new Date((o.day + 1) * DAY_MS),
      ]);
    }
    await writer.db`DELETE FROM data_day WHERE sym_id = ${spec.symId} AND day = ${ds}::date`;
    const w = writer;
    sink = {
      startState: async () => ({
        final: { day: o.day - 1, lastAggId: raw[0]!.a - 1, carry: null, cand: null },
        provisional: [],
      }),
      writeMinute: async (s, d) => {
        deltas.push(d);
        return w.writeMinute(s, d);
      },
      markGap: async () => {},
      writeKlineChecks: async () => {},
    };
  } else {
    sink = {
      startState: async () => ({
        final: { day: o.day - 1, lastAggId: raw[0]!.a - 1, carry: null, cand: null },
        provisional: [],
      }),
      writeMinute: async (_s, d) => {
        deltas.push(d);
        return 'written';
      },
      markGap: async () => {},
      writeKlineChecks: async () => {},
    };
  }
  const dead: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close() {},
  };
  const rec = new Recorder({
    symbols: [o.symbol],
    wsUrl: 'wss://replay.invalid',
    socketFactory: () => dead,
    rest,
    sink,
    spoolDir: null,
    log: o.log,
    klineCheck: false,
    autoLoops: false,
  });
  await rec.start();
  const s = rec.sym.get(o.symbol)!;
  // Stream-Simulation: Blöcke mit Umordnung, Duplikaten und Lücken (fehlende Blöcke holt REST)
  let dup = 0;
  let gaps = 0;
  const BLOCK = 5000;
  for (let i = 0; i < raw.length; i += BLOCK) {
    const block = raw.slice(i, i + BLOCK).map((r) => toItem(r, spec, false));
    const k = i / BLOCK;
    if (k % 7 === 3) {
      gaps++;
      continue; // dieser Block kommt nie per Stream: Lücke
    }
    if (k % 5 === 1) {
      // Umordnung innerhalb des Blocks und Duplikate
      block.reverse();
      block.push(...block.slice(0, 50));
      dup += 50;
    }
    rec.handle(s, block, false);
    while (await rec.catchUpOnce(s)) {
      /* Lücke per REST schließen */
    }
    await rec.drain();
  }
  // Tagesende: Folgetag-Trade simulieren (Marge), dann alle Minuten abschließen
  rec.completeMinutes(s, (o.day + 1) * DAY_MS + 10_000);
  await rec.drain();
  await rec.stop();
  const di = s.days.get(o.day)!;
  const snap = di.live.snapshot();
  const tables: Record<string, boolean> = {};
  for (const t of FP_TABLES) tables[t] = fpDigest(spec.symId, snap.fp[t]) === ref.digests[t];
  tables.bar_1m = barDigest(spec.symId, snap.bar_1m, SOURCE_VISION) === ref.digests.bar_1m;
  tables.bar_1h = barDigest(spec.symId, snap.bar_1h) === ref.digests.bar_1h;
  tables.bar_1d = barDigest(spec.symId, snap.bar_1d) === ref.digests.bar_1d;
  let db: QualityResult | null = null;
  if (writer) {
    db = await compareLiveDay(writer.db, ref);
    await writer.close();
  }
  const equal =
    Object.values(tables).every(Boolean) &&
    (!db ||
      (db.identical === db.officialMinutes &&
        db.differing === 0 &&
        db.missing === 0 &&
        db.extra === 0 &&
        Object.values(db.tablesEqual).every(Boolean)));
  void dayIndex;
  return {
    symbol: o.symbol,
    day: ds,
    rows: raw.length,
    minutes: deltas.length,
    restRequests,
    duplicatesInjected: dup,
    gapsInjected: gaps,
    equal,
    tables,
    db,
    ms: Math.round(performance.now() - t0),
  };
}
