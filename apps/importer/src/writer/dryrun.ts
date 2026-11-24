// Dry-Run-Schreiber: schreibt nichts in eine Datenbank; zählt Zeilen je Tabelle und merkt sich
// Digests. Resume über eine JSONL-Ergebnisdatei (bereits enthaltene Tage werden übersprungen).
import { formatDay } from '@orderflow/core';
import { existsSync, readFileSync } from 'node:fs';
import {
  stateOf,
  type DayWrite,
  type DayWriter,
  type EdgeUpdate,
  type ResumeKey,
  type StoredChain,
  type WriteOutcome,
} from './types.ts';

interface ResumeLine {
  symbol: string;
  day: string;
  aggSha256?: string;
  klineSha256?: string;
  importerVersion?: string;
  carryOut?: { q: number; b: number };
  lastAggId?: number | null;
  edges?: { candQ: number; candB: number }[];
}

const keyOf = (symbol: string, day: string, agg = '', kl = '', ver = '') =>
  `${symbol}|${day}|${agg}|${kl}|${ver}`;

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
  private readonly done = new Set<string>();

  private readonly chains = new Map<string, StoredChain>();

  /** `resumeFrom`: JSONL mit DaySummary-Zeilen früherer Läufe (Felder symbol, day, …). */
  constructor(resumeFrom?: string) {
    if (resumeFrom && existsSync(resumeFrom)) {
      for (const line of readFileSync(resumeFrom, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as ResumeLine;
        this.done.add(keyOf(r.symbol, r.day, r.aggSha256, r.klineSha256, r.importerVersion));
        const last = r.edges?.[1];
        if (r.carryOut && last) {
          this.chains.set(`${r.symbol}|${r.day}`, {
            carry: r.carryOut,
            cand: { q: last.candQ, b: last.candB },
            lastAggId: r.lastAggId ?? null,
          });
        }
      }
    }
  }

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async isDone(k: ResumeKey): Promise<boolean> {
    return this.done.has(
      keyOf(k.symbol, formatDay(k.day), k.aggSha256, k.klineSha256, k.importerVersion),
    );
  }

  async storedChain(symbol: string, day: number): Promise<StoredChain | null> {
    return this.chains.get(`${symbol}|${formatDay(day)}`) ?? null;
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
