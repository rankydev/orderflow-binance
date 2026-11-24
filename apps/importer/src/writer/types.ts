// Schnittstelle des Tages-Schreibers (KONZEPT §4.3). Zwei Implementierungen: Postgres (eine
// Transaktion je Tag, COPY, Single Writer) und Dry-Run (schreibt nichts, sammelt Zähler/Digests).
//
// Ablauf je Tag d: writeDay(d) sofort nach dem Abgleich von d (Minute 1439 noch edge_pending, ihre
// eigene Klasse steht aber schon in data_minute_issue bzw. ist exact); sobald d+1 abgeglichen ist,
// resolveEdge(d, 1439). Minute 0 eines Tages, dessen Vortag beim Schreiben unbekannt war, wird per
// resolveEdge(d, 0, Klasse) mit dem dann bekannten Übertrag entschieden.
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
  rulesVersion: string;
  /** final_bad-Gründe zusätzlich zu mismatch/missing (aggId-Löcher, fehlende Kontinuität). */
  extraBad: string[];
  /** Eingaben aus dem Vortag, mit denen klassifiziert wurde (für Kaskade/„fertig", Review N2). */
  inputs: DayInputs;
  /** ownQualityDigest des Abgleichs. */
  qualityDigest: string;
}

export type CarryOrigin = 'chain' | 'stored' | 'neighbour' | 'estimated';

export interface DayInputs {
  carryIn: { q: number; b: number };
  /** cand(1439) des Vortags (untere Hüllgrenze für Minute 0); null = unbekannt. */
  candIn: { q: number; b: number } | null;
  carryInOrigin: CarryOrigin;
  /** last_agg_id des Vortags (null = unbekannt). */
  prevLastAggId: number | null;
}

export interface WriteOutcome {
  /** Datenbankseitig berechneter Digest (`day_digest_all`) = TS-Digest; beim Dry-Run null. */
  dbDigest: string | null;
  state: 'final_ok' | 'final_bad';
  version: number | null;
}

export interface MinuteFacts {
  dQ: number;
  dB: number;
  sQ: number;
  sB: number;
  candQ: number;
  candB: number;
}

/** Entscheidung einer Randminute (0 oder 1439) eines geschriebenen Tages. */
export interface EdgeUpdate {
  symbol: string;
  symId: number;
  day: number;
  minute: number;
  /**
   * Klasse der Minute (1 exact, 2 shift, 3 mismatch, 5 missing) mit Fakten. Fehlt sie (nur für
   * Minute 1439), gilt die beim Schreiben gespeicherte eigene Klasse.
   */
  decided?: { cls: number; facts: MinuteFacts };
}

/** Gespeicherter Endzustand eines finalen Tages: Übertrag in den Folgetag und letzte aggId. */
export interface StoredChain {
  carry: { q: number; b: number };
  cand: { q: number; b: number };
  lastAggId: number | null;
}

/** Was über einen gespeicherten Tag bekannt ist (Grundlage der Entscheidung „fertig"). */
export interface StoredDay {
  state: string;
  stale: boolean;
  digest: string | null;
  qualityDigest: string | null;
  aggSha256: string | null;
  klineSha256: string | null;
  importerVersion: string | null;
  inputs: DayInputs | null;
  /** null, wenn der Tag nicht final ist oder kein Übertrag gespeichert wurde. */
  chain: StoredChain | null;
}

export interface DayWriter {
  readonly kind: 'postgres' | 'dry-run';
  open(): Promise<void>;
  /** Gespeicherter Zustand eines Tages (null = unbekannt). */
  storedDay(symbol: string, day: number): Promise<StoredDay | null>;
  /** Tag ist unverändert (gleiche Daten, Klassen, Quellen, Eingaben): nur Herkunft aktualisieren. */
  touchDay(day: number, importerVersion: string, rulesVersion: string): Promise<void>;
  /** Vortag hat sich geändert, Neuklassifikation nicht möglich (Quelldateien fehlen). */
  markStale(day: number, reason: string): Promise<void>;
  writeDay(w: DayWrite): Promise<WriteOutcome>;
  /** true, wenn ein gespeicherter Tag tatsächlich aktualisiert wurde (Minute war offen). */
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

export function factsOf(
  r: ReconcileResult,
  cand: { candQ: Float64Array; candB: Float64Array },
  m: number,
): MinuteFacts {
  return {
    dQ: r.dQ[m]!,
    dB: r.dB[m]!,
    sQ: r.sQ[m]!,
    sB: r.sB[m]!,
    candQ: cand.candQ[m]!,
    candB: cand.candB[m]!,
  };
}
