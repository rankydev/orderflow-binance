// Dry-Run-Schreiber: schreibt nichts in eine Datenbank; zählt Zeilen je Tabelle und merkt sich
// Digests. Resume über eine JSONL-Ergebnisdatei (bereits enthaltene Tage werden übersprungen).
import { formatDay } from '@orderflow/core';
import { existsSync, readFileSync } from 'node:fs';
import {
  stateOf,
  type DayInputs,
  type DayWrite,
  type DayWriter,
  type EdgeUpdate,
  type StoredDay,
  type WriteOutcome,
} from './types.ts';

interface ResumeLine {
  symbol: string;
  day: string;
  state?: string;
  digest?: string;
  ownQualityDigest?: string;
  aggSha256?: string;
  klineSha256?: string;
  importerVersion?: string;
  inputs?: DayInputs;
  carryOut?: { q: number; b: number };
  lastAggId?: number | null;
  edges?: { candQ: number; candB: number }[];
}

export interface DryRunRecord {
  symbol: string;
  day: string;
  aggSha256: string;
  importerVersion: string;
  digest: string;
  rows: Record<string, number>;
  state: 'final_ok' | 'final_bad';
}

export class DryRunWriter implements DayWriter {
  readonly kind = 'dry-run' as const;
  readonly records: DryRunRecord[] = [];
  readonly edges: { symbol: string; day: string; minute: number; cls: number }[] = [];
  readonly touched: string[] = [];
  readonly stale: { day: string; reason: string }[] = [];
  private readonly stored = new Map<string, StoredDay>();

  /** `resumeFrom`: JSONL mit DaySummary-Zeilen früherer Läufe; die letzte Zeile je Tag gilt. */
  constructor(resumeFrom?: string) {
    if (resumeFrom && existsSync(resumeFrom)) {
      for (const line of readFileSync(resumeFrom, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as ResumeLine;
        const last = r.edges?.[1];
        this.stored.set(`${r.symbol}|${r.day}`, {
          state: r.state ?? 'unknown',
          stale: false,
          digest: r.digest ?? null,
          qualityDigest: r.ownQualityDigest ?? null,
          aggSha256: r.aggSha256 ?? null,
          klineSha256: r.klineSha256 ?? null,
          importerVersion: r.importerVersion ?? null,
          inputs: r.inputs ?? null,
          chain:
            r.carryOut && last
              ? {
                  carry: r.carryOut,
                  cand: { q: last.candQ, b: last.candB },
                  lastAggId: r.lastAggId ?? null,
                }
              : null,
        });
      }
    }
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async storedDay(symbol: string, day: number): Promise<StoredDay | null> {
    return this.stored.get(`${symbol}|${formatDay(day)}`) ?? null;
  }

  async touchDay(day: number): Promise<void> {
    this.touched.push(formatDay(day));
  }

  async markStale(day: number, reason: string): Promise<void> {
    this.stale.push({ day: formatDay(day), reason });
  }

  async writeDay(w: DayWrite): Promise<WriteOutcome> {
    const rows: Record<string, number> = {};
    for (const [t, tab] of Object.entries(w.data.fp)) rows[t] = tab.n;
    rows.bar_1m = w.data.bar_1m.length;
    rows.bar_1h = w.data.bar_1h.length;
    rows.bar_1d = w.data.bar_1d.length;
    rows.kline_1m = w.data.klines.length;
    const state = stateOf(w.recon, w.extraBad);
    this.records.push({
      symbol: w.data.spec.name,
      day: w.data.dayStr,
      aggSha256: w.aggFile.sha256,
      importerVersion: w.importerVersion,
      digest: w.data.digest,
      rows,
      state,
    });
    return { dbDigest: null, state, version: null };
  }

  async resolveEdge(e: EdgeUpdate): Promise<boolean> {
    this.edges.push({
      symbol: e.symbol,
      day: formatDay(e.day),
      minute: e.minute,
      cls: e.decided?.cls ?? 0,
    });
    return false;
  }
}
