// Schnittstelle des Tages-Schreibers (KONZEPT §4.3). Zwei Implementierungen: Postgres (eine
// Transaktion je Tag, COPY, Single Writer) und Dry-Run (schreibt nichts, sammelt Zähler/Digests).
import type { DayData, DayManifest, FileManifest, ReconcileResult } from '@orderflow/core';

export interface DayWrite {
  data: DayData;
  recon: ReconcileResult;
  aggManifest: DayManifest;
  klineManifest: DayManifest;
  /** Dateieinträge für raw_file (aggTrades-Quelle und Kline-Datei); `days` darf leer sein. */
  aggFile: FileManifest;
  klineFile: FileManifest;
  importerVersion: string;
  /** final_bad-Gründe zusätzlich zu mismatch/missing (aggId-Löcher, fehlende Kontinuität). */
  extraBad: string[];
}

export interface WriteOutcome {
  /** Datenbankseitig berechneter Digest (`day_digest_all`) = TS-Digest; beim Dry-Run null. */
  dbDigest: string | null;
  state: 'final_ok' | 'final_bad';
  version: number | null;
}

/** Nachträgliche Auflösung einer Randminute eines bereits geschriebenen Nachbartags. */
export interface EdgeUpdate {
  symbol: string;
  symId: number;
  day: number;
  /** 0 oder 1439 */
  minute: number;
  recon: ReconcileResult;
  /** Kandidaten je Minute des Nachbartags (für data_minute_issue). */
  cand: { candQ: Float64Array; candB: Float64Array };
}

export interface DayWriter {
  readonly kind: 'postgres' | 'dry-run';
  open(): Promise<void>;
  /** Resume: Tag ist bereits final mit derselben aggTrades-Quelle (SHA256) und Importer-Version. */
  isDone(symbol: string, day: number, aggSha256: string, importerVersion: string): Promise<boolean>;
  writeDay(w: DayWrite): Promise<WriteOutcome>;
  /** true, wenn ein gespeicherter Tag tatsächlich aktualisiert wurde. */
  resolveEdge(e: EdgeUpdate): Promise<boolean>;
  close(): Promise<void>;
}

export function stateOf(
  recon: ReconcileResult,
  extraBad: readonly string[],
): 'final_ok' | 'final_bad' {
  return recon.counts.mismatch + recon.counts.missing === 0 && extraBad.length === 0
    ? 'final_ok'
    : 'final_bad';
}
