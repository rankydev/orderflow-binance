// Abnahmeprüfungen 3, 4 und 5 des Recorders – für den Live-Lauf vorbereitet, NICHT automatisch
// ausgeführt (kein Test, nicht in `npm test`). Alle Prüfungen lesen nur: die DB-Sitzung ist
// `default_transaction_read_only`, HTTP nur GET.
//
//   node --env-file=../../.env scripts/acceptance-live.ts api      [--sym BTCUSDT] [--minutes 30]
//   node --env-file=../../.env scripts/acceptance-live.ts finalise --sym BTCUSDT --day 2026-11-25 [--watch-min 15]
//   node --env-file=../../.env scripts/acceptance-live.ts soak     [--hours 25] [--pid <recorder-pid>] [--out soak.csv]
//
// 3 (api): die API liefert den laufenden Tag mit final=false (Cache-Control ohne Langzeit-Cache),
//    ein steigendes ETag, keine 503-Schleife (höchstens 3 aufeinanderfolgende 503), und in der DB
//    ist je Minute des laufenden Tages bar_1m genau dann vorhanden, wenn fp_1m/fp_1m_b10 Zeilen hat.
// 4 (finalise): nach der In-Process-Finalisierung von <day>: data_day final_ok/final_bad, nicht
//    stale, kein live_frozen; letzter recorder_quality-Eintrag identical/official ≥ 99,9 %;
//    data_day.digest = day_digest_all; Vortag ohne edge_last_pending; während --watch-min Minuten
//    keine weitere Änderung (version, rows, digest) – der Recorder schreibt den Tag nicht mehr.
// 5 (soak): ≥ 24 h je Minute /health und RSS/CPU des Prozesses als CSV; am Ende: Tagesgrenze
//    überschritten (lastCommittedMinute über Mitternacht UTC), mindestens eine WS-Rotation
//    (wsRotations steigt, 23-h-Rotation), RSS-Spitze < 1,2 GB, RSS-Anstieg der letzten 12 h
//    gegenüber den ersten 12 h < 25 %, keine Minute mit healthy=false länger als 5 min am Stück.
import { DAY_MS, getSymbol, parseConfig, parseDay } from '@orderflow/core';
import { connect } from '@orderflow/db';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    sym: { type: 'string', default: 'BTCUSDT' },
    day: { type: 'string' },
    minutes: { type: 'string', default: '30' },
    'watch-min': { type: 'string', default: '15' },
    hours: { type: 'string', default: '25' },
    pid: { type: 'string' },
    out: { type: 'string', default: 'soak.csv' },
    api: { type: 'string', default: process.env.OF_API_URL ?? 'http://127.0.0.1:8780' },
    health: {
      type: 'string',
      default: process.env.OF_RECORDER_HEALTH_URL ?? 'http://127.0.0.1:7701/health',
    },
  },
});

const fails: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) fails.push(what);
};

function readOnlyDb() {
  const sql = connect(parseConfig(process.env).db, undefined, {
    applicationName: 'recorder-acceptance',
  });
  return {
    sql,
    async init() {
      await sql`SET default_transaction_read_only = on`;
      await sql`SET timezone = 'UTC'`;
    },
  };
}

async function checkApi(): Promise<void> {
  const spec = getSymbol(v.sym!);
  const now = Date.now();
  const d0 = now - (now % DAY_MS);
  const url = `${v.api}/api/v1/bars?sym=${spec.name}&tf=1m&from=${d0}&to=${d0 + DAY_MS}`;
  const etags = new Set<string>();
  let consecutive503 = 0;
  let max503 = 0;
  let nonFinal = 0;
  let ok200 = 0;
  const end = now + Number(v.minutes) * 60_000;
  const db = readOnlyDb();
  await db.init();
  let inconsistent = 0;
  while (Date.now() < end) {
    const r = await fetch(url);
    await r.arrayBuffer();
    if (r.status === 503) max503 = Math.max(max503, ++consecutive503);
    else consecutive503 = 0;
    if (r.status === 200) {
      ok200++;
      etags.add(r.headers.get('etag') ?? '');
      if (!/immutable|max-age=[1-9]\d{4,}/.test(r.headers.get('cache-control') ?? '')) nonFinal++;
    }
    // DB: Minuten, in denen bar_1m und Footprint nicht zusammenpassen (je Snapshot, gesperrt wie die API)
    const [x] = await db.sql.begin(
      'isolation level repeatable read read only',
      async (tx) => tx`
      SELECT count(*)::int AS n FROM (
        SELECT b.ts FROM bar_1m b WHERE b.sym_id = ${spec.symId} AND b.ts >= ${new Date(d0)}
           AND NOT EXISTS (SELECT 1 FROM fp_1m f WHERE f.sym_id = b.sym_id AND f.ts = b.ts)
        UNION ALL
        SELECT DISTINCT f.ts FROM fp_1m f WHERE f.sym_id = ${spec.symId} AND f.ts >= ${new Date(d0)}
           AND NOT EXISTS (SELECT 1 FROM bar_1m b WHERE b.sym_id = f.sym_id AND b.ts = f.ts)
        UNION ALL
        SELECT DISTINCT g.ts FROM fp_1m_b10 g WHERE g.sym_id = ${spec.symId} AND g.ts >= ${new Date(d0)}
           AND NOT EXISTS (SELECT 1 FROM bar_1m b WHERE b.sym_id = g.sym_id AND b.ts = g.ts)) q`,
    );
    inconsistent += x!.n as number;
    await sleep(15_000);
  }
  await db.sql.end();
  check(ok200 > 0, `API antwortet mit 200 (${ok200} Antworten)`);
  check(nonFinal === ok200, `laufender Tag nie als final gecacht (${nonFinal}/${ok200})`);
  check(
    etags.size >= Math.min(5, Number(v.minutes) / 2),
    `ETag ändert sich (${etags.size} Fassungen)`,
  );
  check(max503 <= 3, `keine 503-Schleife (max. ${max503} in Folge)`);
  check(
    inconsistent === 0,
    `bar_1m ↔ fp_1m/fp_1m_b10 je Minute konsistent (${inconsistent} Abweichungen)`,
  );
}

async function checkFinalise(): Promise<void> {
  if (!v.day) throw new Error('--day fehlt');
  const spec = getSymbol(v.sym!);
  const day = v.day;
  const prev = new Date((parseDay(day) - 1) * DAY_MS).toISOString().slice(0, 10);
  const db = readOnlyDb();
  await db.init();
  const snap = async () =>
    (
      await db.sql`SELECT state, stale, live_frozen, version, rows, digest, edge_first_pending,
                          day_digest_all(sym_id, day) AS db_digest
                     FROM data_day WHERE sym_id = ${spec.symId} AND day = ${day}::date`
    )[0];
  const a = await snap();
  check(a !== undefined, `data_day ${day} vorhanden`);
  if (!a) return void (await db.sql.end());
  check(a.state === 'final_ok' || a.state === 'final_bad', `Zustand final (${a.state as string})`);
  check(a.stale === false, 'nicht stale');
  check(a.live_frozen === null, `kein live_frozen (${String(a.live_frozen)})`);
  check(a.digest === a.db_digest, 'digest = day_digest_all');
  const [q] = await db.sql`
    SELECT live_minutes, official_minutes, identical_minutes, differing_minutes, missing_minutes,
           extra_minutes, tables_equal FROM recorder_quality
     WHERE sym_id = ${spec.symId} AND day = ${day}::date ORDER BY compared_at DESC LIMIT 1`;
  check(q !== undefined, 'recorder_quality-Eintrag vorhanden');
  if (q) {
    const share = (q.identical_minutes as number) / Math.max(1, q.official_minutes as number);
    console.log('     recorder_quality', JSON.stringify(q));
    check(share >= 0.999, `identische Minuten ${(share * 100).toFixed(3)} % ≥ 99,9 %`);
  }
  const [p] = await db.sql`
    SELECT state, edge_last_pending FROM data_day WHERE sym_id = ${spec.symId} AND day = ${prev}::date`;
  check(
    p !== undefined && p.edge_last_pending === false,
    `Randminute des Vortags ${prev} aufgelöst`,
  );
  console.log(`     beobachte ${v['watch-min']} min auf weitere Schreibvorgänge …`);
  await sleep(Number(v['watch-min']) * 60_000);
  const b = await snap();
  check(
    b !== undefined && b.version === a.version && b.rows === a.rows && b.digest === a.digest,
    `Tag unverändert (version ${String(a.version)} → ${String(b?.version)})`,
  );
  await db.sql.end();
}

async function checkSoak(): Promise<void> {
  const end = Date.now() + Number(v.hours) * 3_600_000;
  writeFileSync(
    v.out!,
    'ts,healthy,rss_mb,cpu_pct,ws_rotations,ws_reconnects,last_minute,db_errors\n',
  );
  const rows: { ts: number; healthy: boolean; rss: number; rot: number; last: string | null }[] =
    [];
  while (Date.now() < end) {
    let h: Record<string, unknown>;
    try {
      h = (await (await fetch(v.health!)).json()) as Record<string, unknown>;
    } catch {
      h = { healthy: false };
    }
    let rss = Number(h.rssMb ?? NaN);
    let cpu = NaN;
    if (v.pid) {
      try {
        const [r, c] = execFileSync('ps', ['-o', 'rss=,pcpu=', '-p', v.pid])
          .toString()
          .trim()
          .split(/\s+/);
        rss = Number(r) / 1024;
        cpu = Number(c);
      } catch {
        /* Prozess weg: als ungesund zählen */
        h.healthy = false;
      }
    }
    const syms = Object.values(
      (h.symbols ?? {}) as Record<string, { lastCommittedMinute?: string }>,
    );
    const last = syms[0]?.lastCommittedMinute ?? null;
    const row = {
      ts: Date.now(),
      healthy: h.healthy === true,
      rss,
      rot: Number(h.wsRotations ?? 0),
      last,
    };
    rows.push(row);
    appendFileSync(
      v.out!,
      [
        new Date(row.ts).toISOString(),
        row.healthy,
        rss.toFixed(0),
        cpu,
        row.rot,
        h.wsReconnects,
        last,
        h.dbWriteErrors,
      ].join(',') + '\n',
    );
    await sleep(60_000);
  }
  const days = new Set(rows.map((r) => r.last?.slice(0, 10)).filter(Boolean));
  check(days.size >= 2, `Tagesgrenze überschritten (${[...days].join(', ')})`);
  check(
    rows.at(-1)!.rot > rows[0]!.rot,
    `WS-Rotation beobachtet (${rows[0]!.rot} → ${rows.at(-1)!.rot})`,
  );
  const peak = Math.max(...rows.map((r) => r.rss).filter(Number.isFinite));
  check(peak < 1200, `RSS-Spitze ${peak.toFixed(0)} MB < 1200 MB`);
  const half = Math.floor(rows.length / 2);
  const avg = (xs: typeof rows) => xs.reduce((s, r) => s + r.rss, 0) / Math.max(1, xs.length);
  const growth = avg(rows.slice(half)) / avg(rows.slice(0, half)) - 1;
  check(
    growth < 0.25,
    `RSS-Anstieg zweite gegenüber erster Hälfte ${(growth * 100).toFixed(1)} % < 25 %`,
  );
  let run = 0;
  let worst = 0;
  for (const r of rows) worst = Math.max(worst, (run = r.healthy ? 0 : run + 1));
  check(worst <= 5, `höchstens 5 min am Stück ungesund (${worst})`);
}

const cmd = positionals[0];
const fn = { api: checkApi, finalise: checkFinalise, soak: checkSoak }[cmd ?? ''];
if (!fn) {
  console.error('Aufruf: acceptance-live.ts api|finalise|soak [Optionen]');
  process.exit(2);
}
await fn();
console.log(
  fails.length ? `\n${fails.length} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden',
);
process.exit(fails.length ? 1 : 0);
