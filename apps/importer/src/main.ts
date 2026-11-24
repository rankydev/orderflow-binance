// Importer-CLI (KONZEPT §2.1, §4.1, §4.3). Aufruf aus dem Repo-Wurzelverzeichnis:
//   node --env-file-if-exists=.env apps/importer/src/main.ts <befehl> [optionen]
// Befehle:
//   import   --symbol S (--day D | --from D --to D | --month YYYY-MM) [--dry-run | --db]
//            [--prefer auto|daily|monthly] [--no-neighbours] [--out datei.jsonl] [--resume]
//            [--sidecar | --sidecar-dir DIR] [--data-dir DIR] [--quiet]
//   download --symbol S --kind aggTrades|klines (--day D | --from D --to D)
// Standard ist --dry-run (schreibt nichts); --db schreibt in die Datenbank aus OF_DB_* (.env).
import {
  getSymbol,
  monthDays,
  parseConfig,
  parseDay,
  RULES_VERSION,
  formatDay,
} from '@orderflow/core';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { downloadFile } from './download.ts';
import type { FileRef } from './files.ts';
import { Importer, type DaySummary, type Prefer } from './pipeline.ts';
import { DryRunWriter } from './writer/dryrun.ts';
import { PostgresWriter } from './writer/postgres.ts';
import type { DayWriter } from './writer/types.ts';

const PKG_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
export const IMPORTER_VERSION = `importer@${PKG_VERSION}+rules${RULES_VERSION}`;

export const USAGE = `Verwendung:
  importer import --symbol BTCUSDT (--day YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD | --month YYYY-MM)
                  [--dry-run | --db] [--prefer auto|daily|monthly] [--no-neighbours]
                  [--out ergebnis.jsonl] [--resume] [--sidecar | --sidecar-dir DIR] [--data-dir DIR] [--quiet]
  importer download --symbol BTCUSDT --kind aggTrades|klines (--day YYYY-MM-DD | --from … --to …)`;

export class UsageError extends Error {}

export interface ImportArgs {
  symbol: string;
  firstDay: number;
  lastDay: number;
  mode: 'dry-run' | 'db';
  prefer: Prefer;
  neighbours: boolean;
  out?: string;
  resume: boolean;
  sidecar: false | { dir?: string };
  dataDir: string;
  quiet: boolean;
}

function dayRange(v: Record<string, string | boolean | undefined>): [number, number] {
  const day = v.day as string | undefined;
  const from = v.from as string | undefined;
  const to = v.to as string | undefined;
  const month = v.month as string | undefined;
  const given = [
    day !== undefined,
    from !== undefined || to !== undefined,
    month !== undefined,
  ].filter(Boolean);
  if (given.length !== 1)
    throw new UsageError('genau eines von --day, --from/--to, --month angeben');
  if (day) return [parseDay(day), parseDay(day)];
  if (month) return monthDays(month);
  if (!from || !to) throw new UsageError('--from und --to gehören zusammen');
  const a = parseDay(from);
  const b = parseDay(to);
  if (b < a) throw new UsageError('--to liegt vor --from');
  return [a, b];
}

export function parseImportArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): ImportArgs {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      symbol: { type: 'string' },
      day: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      month: { type: 'string' },
      'dry-run': { type: 'boolean' },
      db: { type: 'boolean' },
      prefer: { type: 'string' },
      'no-neighbours': { type: 'boolean' },
      out: { type: 'string' },
      resume: { type: 'boolean' },
      sidecar: { type: 'boolean' },
      'sidecar-dir': { type: 'string' },
      'data-dir': { type: 'string' },
      quiet: { type: 'boolean' },
    },
    strict: true,
  });
  if (!v.symbol) throw new UsageError('--symbol fehlt');
  getSymbol(v.symbol);
  if (v['dry-run'] && v.db) throw new UsageError('--dry-run und --db schließen sich aus');
  const prefer = (v.prefer ?? 'auto') as Prefer;
  if (!['auto', 'daily', 'monthly'].includes(prefer))
    throw new UsageError('--prefer auto|daily|monthly');
  if (v.resume && !v.db && !v.out) throw new UsageError('--resume braucht --db oder --out');
  const [firstDay, lastDay] = dayRange(v);
  const mode = v.db ? 'db' : 'dry-run';
  const sidecar: ImportArgs['sidecar'] = v['sidecar-dir']
    ? { dir: v['sidecar-dir'] }
    : v.sidecar
      ? {}
      : false;
  const a: ImportArgs = {
    symbol: v.symbol,
    firstDay,
    lastDay,
    mode,
    prefer,
    neighbours: !v['no-neighbours'],
    resume: !!v.resume,
    sidecar,
    dataDir: v['data-dir'] ?? env.OF_DATA_DIR ?? 'data',
    quiet: !!v.quiet,
  };
  if (v.out) a.out = v.out;
  return a;
}

async function runImport(argv: string[]): Promise<number> {
  const a = parseImportArgs(argv, process.env);
  const spec = getSymbol(a.symbol);
  const writer: DayWriter =
    a.mode === 'db'
      ? new PostgresWriter(parseConfig(process.env).db, spec)
      : new DryRunWriter(a.resume ? a.out : undefined);
  const log = (s: string) => {
    if (!a.quiet) console.log(s);
  };
  const t0 = performance.now();
  await writer.open();
  let summaries: DaySummary[];
  try {
    const imp = new Importer({
      dataDir: a.dataDir,
      spec,
      firstDay: a.firstDay,
      lastDay: a.lastDay,
      prefer: a.prefer,
      neighbours: a.neighbours,
      writer,
      importerVersion: IMPORTER_VERSION,
      sidecar: a.sidecar,
      log: (s) => {
        log(s);
      },
    });
    summaries = await imp.run();
  } finally {
    await writer.close();
  }
  if (a.out) {
    for (const s of summaries) if (!s.skipped) appendFileSync(a.out, JSON.stringify(s) + '\n');
  }
  const wall = (performance.now() - t0) / 1000;
  const rows = summaries.reduce((x, s) => x + s.rows, 0);
  const bad = summaries.filter((s) => s.state === 'final_bad');
  const pend = summaries.reduce((x, s) => x + s.counts.edge_pending, 0);
  const rssMb = Math.round(process.resourceUsage().maxRSS / 1024);
  console.log(
    `${a.mode} ${spec.name} ${formatDay(a.firstDay)}…${formatDay(a.lastDay)}: ${summaries.length} Tage, ` +
      `${rows.toLocaleString('en-US')} aggTrades, ${wall.toFixed(1)} s Wandzeit, ` +
      `${Math.round(rows / wall).toLocaleString('en-US')} rows/s, Spitzen-RSS ${rssMb} MB, ` +
      `final_bad=${bad.length}, edge_pending-Minuten=${pend}`,
  );
  return bad.length > 0 ? 3 : 0;
}

async function runDownload(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      symbol: { type: 'string' },
      kind: { type: 'string' },
      day: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      'data-dir': { type: 'string' },
    },
    strict: true,
  });
  if (!v.symbol) throw new UsageError('--symbol fehlt');
  getSymbol(v.symbol);
  if (v.kind !== 'aggTrades' && v.kind !== 'klines')
    throw new UsageError('--kind aggTrades|klines');
  const [a, b] = dayRange(v);
  const dataDir = v['data-dir'] ?? process.env.OF_DATA_DIR ?? 'data';
  for (let d = a; d <= b; d++) {
    const ref: FileRef = {
      kind: v.kind,
      origin: 'daily',
      symbol: v.symbol,
      period: formatDay(d),
    } as FileRef;
    const r = await downloadFile(dataDir, ref, (s) => console.log(s));
    console.log(`${r.skipped ? 'vorhanden' : 'neu'} ${r.path} ${r.sha256}`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'import') return await runImport(rest);
    if (cmd === 'download') return await runDownload(rest);
    console.error(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && 'code' in e)) {
      console.error(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exitCode = 1;
    },
  );
}
