// Tägliche Finalisierung im Recorder-Prozess (KONZEPT §4.3): sobald die offiziellen Tagesdateien
// (aggTrades + 1m-Klines) für Tag d vorliegen, mit Checksumme laden und den normalen Import für d
// ausführen (Importer-Bibliothek, Importer-Lock; ersetzt den provisorischen Tag in einer
// Transaktion, klassifiziert, löst die Randminute von d−1, macht den Tag `immutable`). Vor dem
// Ersatz wird der live geschriebene Tag minutenweise mit dem offiziellen verglichen und das Ergebnis
// in recorder_quality festgehalten.
import {
  DAY_MS,
  formatDay,
  pgTimestamptz,
  sha256Hex,
  type DayData,
  type DbConfig,
  type SymbolSpec,
} from '@orderflow/core';

const createHashLine = (lines: string[]) => sha256Hex(lines.join('\n'));
import {
  downloadFile,
  IMPORTER_VERSION,
  Importer,
  PostgresWriter,
  type FileRef,
  type StoredDay,
} from '@orderflow/importer';
import type { Sql } from '@orderflow/db';

export interface QualityResult {
  liveMinutes: number;
  officialMinutes: number;
  identical: number;
  differing: number;
  missing: number;
  extra: number;
  tablesEqual: Record<string, boolean>;
  firstDiff: { minute: string; what: string }[];
}

const BAR_ROW =
  'ROW(sym_id, ts, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a, notional, first_agg_id, last_agg_id, first_trade_ms, last_trade_ms, run_max, run_min, d_from_low, d_from_high)::text';

/** Minutenweiser Vergleich des gespeicherten (live) Tages mit dem offiziellen Ergebnis. */
export async function compareLiveDay(sql: Sql, data: DayData): Promise<QualityResult> {
  const symId = data.spec.symId;
  const from = new Date(data.day * DAY_MS);
  const to = new Date((data.day + 1) * DAY_MS);
  // live: je Minute SHA256 über die fp_1m-Zeilen und den bar_1m-Text (ohne source/check_state);
  // Zeittext in UTC unabhängig von der Sitzung (SET LOCAL)
  const [liveFp, liveBar] = await sql.begin(async (tx) => {
    await tx`SET LOCAL timezone = 'UTC'`;
    const a = await tx.unsafe(
      `SELECT ts, encode(sha256(convert_to(string_agg(ROW(sym_id, ts, px, buy_q, sell_q, buy_a, sell_a)::text, E'\\n' ORDER BY px), 'UTF8')), 'hex') AS h
         FROM fp_1m WHERE sym_id = $1 AND ts >= $2 AND ts < $3 GROUP BY ts`,
      [symId, from, to],
    );
    const b = await tx.unsafe(
      `SELECT ts, ${BAR_ROW} AS t FROM bar_1m WHERE sym_id = $1 AND ts >= $2 AND ts < $3`,
      [symId, from, to],
    );
    return [a, b] as const;
  });
  const lf = new Map<number, string>(liveFp.map((r) => [(r.ts as Date).getTime(), r.h as string]));
  const lb = new Map<number, string>(liveBar.map((r) => [(r.ts as Date).getTime(), r.t as string]));
  // offiziell: gleiche Textform
  const of = new Map<number, string[]>();
  const t = data.fp.fp_1m;
  for (let i = 0; i < t.n; i++) {
    const ts = t.ts[i]!;
    const line = `(${symId},"${pgTimestamptz(ts)}",${t.px[i]},${t.buyQ[i]},${t.sellQ[i]},${t.buyA[i]},${t.sellA[i]})`;
    const a = of.get(ts) ?? [];
    a.push(line);
    of.set(ts, a);
  }
  const ob = new Map<number, string>();
  for (const b of data.bar_1m) {
    ob.set(
      b.ts,
      `(${symId},"${pgTimestamptz(b.ts)}",${b.open},${b.high},${b.low},${b.close},${b.buyQ},${b.sellQ},${b.buyA},${b.sellA},${b.notional},${b.firstAggId},${b.lastAggId},${b.firstTradeMs},${b.lastTradeMs},${b.runMax},${b.runMin},${b.dFromLow},${b.dFromHigh})`,
    );
  }
  const r: QualityResult = {
    liveMinutes: lb.size,
    officialMinutes: ob.size,
    identical: 0,
    differing: 0,
    missing: 0,
    extra: 0,
    tablesEqual: {},
    firstDiff: [],
  };
  for (const [ts, bar] of ob) {
    const live = lb.get(ts);
    if (live === undefined) {
      r.missing++;
      continue;
    }
    const fpSame = lf.get(ts) === createHashLine(of.get(ts) ?? []);
    if (fpSame && live === bar) r.identical++;
    else {
      r.differing++;
      if (r.firstDiff.length < 10) {
        r.firstDiff.push({ minute: new Date(ts).toISOString(), what: fpSame ? 'bar_1m' : 'fp_1m' });
      }
    }
  }
  for (const ts of lb.keys()) if (!ob.has(ts)) r.extra++;
  // Tabellen außer bar_1m (dessen source sich zwangsläufig unterscheidet)
  for (const tbl of Object.keys(data.digests)) {
    if (tbl === 'bar_1m' || tbl === 'kline_1m') continue;
    const [d] =
      await sql`SELECT day_digest(${tbl}, ${symId}::smallint, ${formatDay(data.day)}::date) AS d`;
    r.tablesEqual[tbl] = d!.d === data.digests[tbl as keyof typeof data.digests];
  }
  return r;
}

export interface FinaliseOptions {
  dataDir: string;
  cfg: DbConfig;
  spec: SymbolSpec;
  day: number;
  /** Lesende Verbindung für den Vergleich (die des Recorders). */
  sql: Sql;
  log: (s: string) => void;
}

/** Wo nach dem Festschreiben des Tages ein Fehler auftrat (Review H3a). */
export type PostCommitSource = 'conversion' | 'settle' | 'cascade' | 'close' | 'other';
export interface PostCommitError {
  source: PostCommitSource;
  message: string;
}
export type FinaliseResult =
  | 'done'
  | 'not_available'
  | 'lock_busy'
  | { quality: QualityResult | null; postCommitError?: PostCommitError };

interface DayRow {
  state: string;
  version: number;
}

/**
 * Entscheidung nach einem Fehler im Import (Review H3): Erfolg (der Tag ist durch DIESEN Lauf final
 * geworden – final und Version gestiegen) oder Fehler weiterwerfen. Ein Tag, der schon vorher final
 * war und unverändert blieb, oder der nicht final ist, ist kein Erfolg.
 */
export function decideAfterError(before: DayRow | null, after: DayRow | null): 'success' | 'throw' {
  const final = after?.state === 'final_ok' || after?.state === 'final_bad';
  if (!after || !final) return 'throw';
  if (before !== null && after.version <= before.version) return 'throw';
  return 'success';
}

/**
 * Lädt die offiziellen Dateien für Tag d (falls noch nicht vorhanden) und importiert d.
 * Liefert 'not_available', solange Binance die Dateien noch nicht anbietet (HTTP 404).
 */
export async function finaliseDay(o: FinaliseOptions): Promise<FinaliseResult> {
  const ds = formatDay(o.day);
  const refs: FileRef[] = [
    { kind: 'aggTrades', origin: 'daily', symbol: o.spec.name, period: ds },
    { kind: 'klines', origin: 'daily', symbol: o.spec.name, period: ds },
  ];
  for (const ref of refs) {
    try {
      await downloadFile(o.dataDir, ref, o.log);
    } catch (e) {
      if (String(e).includes('HTTP 404')) return 'not_available';
      throw e;
    }
  }
  const writer = new PostgresWriter(o.cfg, o.spec, { log: o.log });
  try {
    await writer.open();
  } catch (e) {
    if (String(e).includes('Schreib-Lock')) return 'lock_busy';
    throw e;
  }
  let quality: QualityResult | null = null;
  const versionOf = async () =>
    ((
      await o.sql`SELECT state, version FROM data_day WHERE sym_id = ${o.spec.symId} AND day = ${ds}::date`
    )[0] ?? null) as DayRow | null;
  const before = await versionOf();
  // Welcher Schreibschritt gerade läuft (für die Quelle eines Fehlers nach dem Festschreiben):
  // writeDay des Zieltags → Konvertierung danach; writeDay/markStale eines anderen Tages → Kaskade;
  // resolveEdge → Randminute (settle). Nach erfolgreichem Schritt zurück auf 'other'.
  let phase: PostCommitSource = 'other';
  const phaseOf = (k: PropertyKey, a: unknown[]): PostCommitSource | null => {
    if (k === 'resolveEdge') return 'settle';
    if (k === 'markStale' || k === 'touchDay') return 'cascade';
    if (k === 'writeDay')
      return (a[0] as { data: { day: number } }).data.day === o.day ? 'conversion' : 'cascade';
    return null;
  };
  const tracked = new Proxy(writer, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r) as unknown;
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => {
        const p = phaseOf(k, a);
        if (p) phase = p;
        const out = await (v as (...x: unknown[]) => Promise<unknown>).apply(t, a);
        if (p) phase = 'other';
        return out;
      };
    },
  });
  let err: unknown = null;
  let source: PostCommitSource = 'other';
  try {
    await runImport();
  } catch (e) {
    err = e;
    source = phase;
  }
  try {
    await writer.close();
  } catch (e) {
    if (err === null) {
      err = e; // sonst den ersten Fehler melden
      source = 'close';
    }
  }
  if (err !== null) {
    const e = err;
    // Review H3: ein Fehler NACH dem Festschreiben (Columnstore-Konvertierung, close-Durchlauf)
    // lässt einen finalen Tag zurück. Der gilt für die Schleife als finalisiert; der Fehler wird
    // getrennt gemeldet, statt alle Folgetage provisorisch hängen zu lassen.
    if (decideAfterError(before, await versionOf()) === 'throw') throw e;
    return {
      quality,
      postCommitError: { source, message: e instanceof Error ? e.message : String(e) },
    };
  }
  return { quality };

  async function runImport(): Promise<void> {
    await new Importer({
      dataDir: o.dataDir,
      spec: o.spec,
      firstDay: o.day,
      lastDay: o.day,
      prefer: 'daily',
      neighbours: true,
      writer: tracked,
      importerVersion: IMPORTER_VERSION,
      sidecar: false,
      log: o.log,
      onBeforeWrite: async (data: DayData, stored: StoredDay | null) => {
        if (stored?.state !== 'provisional' && stored?.state !== 'provisional_import_failed')
          return;
        quality = await compareLiveDay(o.sql, data);
        await o.sql`
          INSERT INTO recorder_quality (sym_id, day, live_minutes, official_minutes, identical_minutes,
            differing_minutes, missing_minutes, extra_minutes, tables_equal, first_diff)
          VALUES (${o.spec.symId}, ${ds}::date, ${quality.liveMinutes}, ${quality.officialMinutes},
            ${quality.identical}, ${quality.differing}, ${quality.missing}, ${quality.extra},
            ${o.sql.json(quality.tablesEqual as never)}, ${o.sql.json(quality.firstDiff as never)})`;
        o.log(
          `Recorder-Qualität ${o.spec.name} ${ds}: ${quality.identical}/${quality.officialMinutes} Minuten identisch, ` +
            `${quality.differing} abweichend, ${quality.missing} fehlend, ${quality.extra} zusätzlich`,
        );
      },
    }).run();
  }
}

/** Nächster Versuchszeitpunkt: ab 06:00 UTC des Folgetags, dann alle `everyMs`. */
export function nextAttempt(
  day: number,
  now: number,
  lastAttempt: number | null,
  everyMs: number,
): number {
  const earliest = (day + 1) * DAY_MS + 6 * 3600_000;
  if (now < earliest) return earliest;
  if (lastAttempt === null) return now;
  return lastAttempt + everyMs;
}
