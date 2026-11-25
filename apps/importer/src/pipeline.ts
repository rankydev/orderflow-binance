// Import-Ablauf für einen Tagesbereich eines Symbols (KONZEPT §3.1, §4.1, §4.3, §4.6):
// Quelle je Tag wählen (Tagesdatei oder Tagesanteil der Monatsdatei), SHA256 prüfen, streamen,
// je Tag aggregieren, Klines lesen, abgleichen (Übertrag über Tagesgrenzen, auch über
// Monatsgrenzen), Manifest bilden, schreiben. Tag d wird sofort geschrieben (Minute 1439
// edge_pending) und Minute 1439 per resolveEdge entschieden, sobald d+1 abgeglichen ist; gehalten
// werden nur die kleinen Abgleich-Eingaben. An den Bereichsrändern werden die Nachbartage nur
// gelesen (nicht geschrieben), sofern ihre Dateien vorliegen; ein gespeicherter Vortag hat Vorrang.
import {
  buildDayData,
  buildReconcileInput,
  comparableDayManifest,
  formatDay,
  monthDays,
  monthOfDay,
  ownQualityDigest,
  qualityDigest,
  reconcileDay,
  RULES_VERSION,
  type DayData,
  type DayManifest,
  type DayStats,
  type FileManifest,
  type NeighbourIn,
  type ReconcileInput,
  type ReconcileResult,
  type SymbolSpec,
} from '@orderflow/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  absPath,
  isPresent,
  relPath,
  verifyFile,
  type FileRef,
  type VerifiedFile,
} from './files.ts';
import { readAggTrades, readKlineDay, type AggDayChunk } from './readers.ts';
import {
  factsOf,
  stateOf,
  type CarryOrigin,
  type DayInputs,
  type DayWriter,
  type StoredDay,
  type WriteOutcome,
} from './writer/types.ts';

function emptyInput(): ReconcileInput {
  const z = () => new Float64Array(1440);
  return {
    ourQ: z(),
    ourB: z(),
    hasRow: new Uint8Array(1440),
    klQ: z(),
    klB: z(),
    hasKline: new Uint8Array(1440),
    candQ: z(),
    candB: z(),
  };
}

export type Prefer = 'auto' | 'daily' | 'monthly';

export interface ImportOptions {
  dataDir: string;
  spec: SymbolSpec;
  firstDay: number;
  lastDay: number;
  prefer: Prefer;
  /** Nachbartage an den Bereichsrändern lesen, um die Randminuten aufzulösen. */
  neighbours: boolean;
  writer: DayWriter;
  importerVersion: string;
  /** Sidecar-Manifeste schreiben: false = nie; sonst Zielverzeichnis (undefined = neben der Datei). */
  sidecar: false | { dir?: string };
  log: (line: string) => void;
  /** Optional: je abgeschlossenem Tag die Abgleich-Eingaben und das Ergebnis (Tests, Golden). */
  onDayData?: (
    day: { symbol: string; dayStr: string; reconcileInput: ReconcileInput },
    recon: ReconcileResult,
  ) => void;
  /** Optional: je abgeschlossenem Tag (z. B. sofort an eine Ergebnisdatei anhängen). */
  onSummary?: (s: DaySummary) => void;
  /** Tage des Bereichs immer neu schreiben (auch wenn identisch gespeichert). */
  force?: boolean;
}

export interface MinuteDetail {
  minute: number;
  cls: string;
  ownCls: string;
  dQ: number;
  dB: number;
  sQ: number;
  sB: number;
  candQ: number;
  candB: number;
}

export interface DaySummary {
  symbol: string;
  day: string;
  aggSha256: string;
  klineSha256: string;
  importerVersion: string;
  origin: 'daily' | 'monthly';
  originPath: string;
  rows: number;
  firstAggId: number | null;
  lastAggId: number | null;
  aggIdHoles: number;
  continuesPrev: boolean | null;
  fpRows: Record<string, number>;
  bars: number;
  candidates: number;
  exactQ: number;
  exactB: number;
  counts: ReconcileResult['counts'];
  carryIn: { q: number; b: number };
  carryInKnown: boolean;
  carryInInferred: { q: number; b: number };
  carryOut: { q: number; b: number };
  totals: ReconcileResult['totals'];
  edges: MinuteDetail[];
  issues: MinuteDetail[];
  ohlc: DayData['ohlc'];
  minStepUnits: number;
  digest: string;
  digests: DayData['digests'];
  qualityDigest: string;
  /** Digest der eigenen Klassen (data_day.quality_digest). */
  ownQualityDigest: string;
  inputs: DayInputs;
  /** write = neu/geändert geschrieben; skip = unverändert; keep = gespeicherte (bessere) Klassifikation behalten. */
  decision: 'write' | 'skip' | 'keep';
  reasons: string[];
  manifest: ReturnType<typeof comparableDayManifest>;
  state: 'final_ok' | 'final_bad';
  extraBad: string[];
  skipped: boolean;
  dbDigest: string | null;
  timing: { readMs: number; buildMs: number; writeMs: number; rowsPerSec: number };
}

const CLS = ['', 'exact', 'shift', 'mismatch', 'edge_pending', 'missing'];

/** Gründe, einen Tag (neu) zu schreiben; leer = gespeicherter Tag ist identisch. */
export function writeReasons(
  st: StoredDay | null,
  now: { digest: string; quality: string; aggSha: string; klineSha: string; inputs: DayInputs },
): string[] {
  if (!st) return ['neu'];
  if (st.state !== 'final_ok' && st.state !== 'final_bad') return [`Zustand ${st.state}`];
  const r: string[] = [];
  if (st.stale) r.push('stale');
  if (st.digest !== now.digest) r.push('Daten');
  if (st.qualityDigest !== now.quality) r.push('Klassifikation');
  const si = st.inputs;
  if (
    !si ||
    si.carryIn.q !== now.inputs.carryIn.q ||
    si.carryIn.b !== now.inputs.carryIn.b ||
    si.prevLastAggId !== now.inputs.prevLastAggId ||
    si.candIn?.q !== now.inputs.candIn?.q ||
    si.candIn?.b !== now.inputs.candIn?.b
  ) {
    r.push('Vortagseingaben');
  }
  // Andere Quelldatei (z. B. Tages- statt Monatsdatei, oder ein auf den VPS übertragener Tag, der
  // dort aus der Tagesdatei neu berechnet wird) mit identischen Daten- und Klassen-Digests ist kein
  // Grund zum Schreiben: „fertig" hängt von den Daten ab, nicht von der Herkunft (Review N3).
  if (r.length > 0) {
    if (st.aggSha256 !== now.aggSha) r.push('aggTrades-Datei');
    if (st.klineSha256 !== now.klineSha) r.push('Kline-Datei');
  }
  return r;
}

function minuteDetail(r: ReconcileResult, inp: DayData['reconcileInput'], m: number): MinuteDetail {
  return {
    minute: m,
    cls: CLS[r.cls[m]!]!,
    ownCls: CLS[r.ownCls[m]!]!,
    dQ: r.dQ[m]!,
    dB: r.dB[m]!,
    sQ: r.sQ[m]!,
    sB: r.sB[m]!,
    candQ: inp.candQ[m]!,
    candB: inp.candB[m]!,
  };
}

interface Source {
  ref: FileRef;
  path: string;
  rel: string;
  firstDay: number;
  lastDay: number;
}

/** Quelle der aggTrades eines Tages; null, wenn keine vollständige Datei (mit .CHECKSUM) vorliegt. */
export function resolveAggSource(
  dataDir: string,
  symbol: string,
  day: number,
  prefer: Prefer,
): Source | null {
  const dayStr = formatDay(day);
  const daily: FileRef = { kind: 'aggTrades', origin: 'daily', symbol, period: dayStr };
  const month = monthOfDay(day);
  const monthly: FileRef = { kind: 'aggTrades', origin: 'monthly', symbol, period: month };
  const [mFirst, mLast] = monthDays(month);
  const mk = (ref: FileRef, f: number, l: number): Source => ({
    ref,
    path: absPath(dataDir, ref),
    rel: relPath(ref),
    firstDay: f,
    lastDay: l,
  });
  const d = mk(daily, day, day);
  const m = mk(monthly, mFirst, mLast);
  if (prefer === 'daily') return isPresent(d.path) ? d : null;
  if (prefer === 'monthly') return isPresent(m.path) ? m : null;
  if (isPresent(d.path)) return d;
  if (isPresent(m.path)) return m;
  return null;
}

export function klineRef(symbol: string, day: number): FileRef {
  return { kind: 'klines', origin: 'daily', symbol, period: formatDay(day) };
}

function fileManifest(
  src: { rel: string; ref: FileRef },
  v: VerifiedFile,
  headerPresent: boolean,
  rows: number,
  version: string,
  days: DayManifest[],
): FileManifest {
  return {
    path: src.rel,
    symbol: src.ref.symbol,
    kind: src.ref.kind,
    origin: src.ref.origin,
    period: src.ref.period,
    bytes: v.bytes,
    sha256: v.sha256,
    checksumExpected: v.checksumExpected,
    checksumOk: v.sha256 === v.checksumExpected,
    headerPresent,
    rows,
    downloadedAt: v.mtime,
    importerVersion: version,
    days,
  };
}

function aggDayManifest(
  spec: SymbolSpec,
  day: number,
  src: Source,
  v: VerifiedFile,
  stats: DayStats,
  continuesPrev: boolean | null,
  headerPresent: boolean,
  version: string,
): DayManifest {
  return {
    symbol: spec.name,
    kind: 'aggTrades',
    day: formatDay(day),
    origin: src.ref.origin,
    originPath: src.rel,
    originSha256: v.sha256,
    rows: stats.rows,
    firstAggId: stats.firstAggId,
    lastAggId: stats.lastAggId,
    aggIdHoles: stats.holes,
    aggIdDups: stats.dups,
    tsBackwards: stats.tsBackwards,
    continuesPrev,
    firstTs: stats.firstTs,
    lastTs: stats.lastTs,
    tradeIdGapSum: stats.tradeIdGapSum,
    tradeIdGapMax: stats.tradeIdGapMax,
    maxTimeGapMs: stats.maxTimeGapMs,
    headerPresent,
    downloadedAt: v.mtime,
    importerVersion: version,
  };
}

interface Prepared {
  day: number;
  data: DayData;
  stats: DayStats;
  src: Source;
  aggV: VerifiedFile;
  klineV: VerifiedFile;
  klineRel: string;
  klineHeader: boolean;
  headerPresent: boolean;
  readMs: number;
  buildMs: number;
}

interface Chain {
  day: number;
  prevIn: NeighbourIn;
  lastAggId: number | null;
  /** Herkunft des Übertrags, den der Folgetag verwendet. */
  origin: CarryOrigin;
}

/** Stärke einer Übertrags-Herkunft: ein schwächerer Lauf überschreibt keine bessere Klassifikation. */
const ORIGIN_RANK: Record<CarryOrigin, number> = {
  estimated: 0,
  neighbour: 1,
  stored: 2,
  chain: 2,
};

/** Tag mit noch offener Minute 1439 (nur die kleinen Abgleich-Eingaben werden gehalten). */
interface OpenDay {
  day: number;
  inp: ReconcileInput;
  prevIn: NeighbourIn | undefined;
  /** Zusammenfassung des Tages im Lauf (null = Nachbartag außerhalb des Bereichs). */
  summary: DaySummary | null;
  extraBad: string[];
  /** Nur für Nachbartage ohne gespeicherten Zustand: eigene Klasse/Fakten aus der Nachbaranalyse. */
  neighbourRecon?: ReconcileResult;
}

/** Warum ein gespeicherter Tag mit anderen Vortagseingaben klassifiziert wurde (null = gleich). */
export function inputsDiffer(
  st: StoredDay,
  ch: Chain | { prevIn: NeighbourIn; lastAggId: number | null },
): string | null {
  if (!st.inputs) return 'Vortagseingaben unbekannt';
  const c = st.inputs.carryIn;
  if (c.q !== ch.prevIn.carry.q || c.b !== ch.prevIn.carry.b) {
    return `Übertrag des Vortags ${c.q}/${c.b} → ${ch.prevIn.carry.q}/${ch.prevIn.carry.b}`;
  }
  if (st.inputs.prevLastAggId !== ch.lastAggId) {
    return `letzte aggId des Vortags ${st.inputs.prevLastAggId} → ${ch.lastAggId}`;
  }
  const k = st.inputs.candIn;
  if (!k || k.q !== ch.prevIn.cand.q || k.b !== ch.prevIn.cand.b) {
    return `cand(1439) des Vortags ${k ? `${k.q}/${k.b}` : 'unbekannt'} → ${ch.prevIn.cand.q}/${ch.prevIn.cand.b}`;
  }
  if (st.stale) return 'als stale markiert';
  return null;
}

export class Importer {
  private readonly verified = new Map<string, Promise<VerifiedFile>>();
  readonly summaries: DaySummary[] = [];
  private readonly o: ImportOptions;
  constructor(o: ImportOptions) {
    this.o = o;
  }

  private verify(path: string): Promise<VerifiedFile> {
    let p = this.verified.get(path);
    if (!p) {
      p = verifyFile(path);
      this.verified.set(path, p);
    }
    return p;
  }

  private async readKlines(day: number) {
    const ref = klineRef(this.o.spec.name, day);
    const path = absPath(this.o.dataDir, ref);
    if (!isPresent(path)) {
      throw new Error(
        `Kline-Tagesdatei fehlt: ${relPath(ref)} (importer download --kind klines …)`,
      );
    }
    const v = await this.verify(path);
    const k = await readKlineDay(path, this.o.spec, day);
    return { v, rel: relPath(ref), ...k };
  }

  /**
   * Nachbartag nur lesen und abgleichen (nicht schreiben). null, wenn Dateien fehlen, der Tag in
   * der Datei fehlt oder die Datei defekt ist (ein optionaler Nachbar bricht den Import nicht ab).
   */
  private async analyseNeighbour(day: number, prev?: NeighbourIn) {
    const { spec, dataDir, log } = this.o;
    // Nachbartage aus der besten verfügbaren Quelle (Tages- und Monatsdatei sind gleichwertig, §3.1).
    const src = resolveAggSource(dataDir, spec.name, day, 'auto');
    const kref = klineRef(spec.name, day);
    if (!src || !isPresent(absPath(dataDir, kref))) return null;
    try {
      await this.verify(src.path);
      let chunk: AggDayChunk | undefined;
      await readAggTrades(src.path, spec, {
        firstDay: src.firstDay,
        lastDay: src.lastDay,
        want: (d) => d === day,
        stopAfterDay: day,
        onDay: (c) => {
          if (c.day === day) chunk = c;
        },
      });
      if (!chunk?.agg || chunk.day !== day) return null;
      const kl = await this.readKlines(day);
      const inp = buildReconcileInput(chunk.agg, kl.klines);
      const recon = reconcileDay(inp, { prev, nextReconciled: true });
      return { recon, stats: chunk.stats, src, inp };
    } catch (e) {
      log(
        `Nachbartag ${formatDay(day)} unlesbar, ignoriert: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  private chain: Chain | null = null;
  private open: OpenDay | null = null;

  async run(): Promise<DaySummary[]> {
    const { spec, firstDay, writer, log } = this.o;
    let lastDay = this.o.lastDay;

    // Vortag des Bereichs: gespeicherter Zustand (DB/Resume) hat Vorrang vor der Neuberechnung,
    // damit ein Lauf und mehrere Teilläufe identisch klassifizieren (die Kette des gespeicherten
    // Tages ist maßgeblich, nicht ein aus dem Tag geschätzter Übertrag).
    const stored = (await writer.storedDay(spec.name, firstDay - 1))?.chain ?? null;
    if (stored) {
      this.chain = {
        day: firstDay - 1,
        prevIn: { carry: stored.carry, cand: stored.cand },
        lastAggId: stored.lastAggId,
        origin: 'stored',
      };
      this.open = {
        day: firstDay - 1,
        inp: emptyInput(),
        prevIn: undefined,
        summary: null,
        extraBad: [],
      };
      log(
        `Vortag ${formatDay(firstDay - 1)} aus dem Speicher: Übertrag q=${stored.carry.q} b=${stored.carry.b}`,
      );
    } else if (this.o.neighbours) {
      const n = await this.analyseNeighbour(firstDay - 1);
      if (n) {
        this.chain = {
          day: firstDay - 1,
          prevIn: { carry: n.recon.carryOut, cand: n.recon.candLast },
          lastAggId: n.stats.lastAggId,
          origin: 'neighbour',
        };
        this.open = {
          day: firstDay - 1,
          inp: n.inp,
          prevIn: undefined,
          summary: null,
          extraBad: [],
          neighbourRecon: n.recon,
        };
        log(
          `Nachbartag ${formatDay(firstDay - 1)} gelesen: Übertrag s(1439) q=${n.recon.carryOut.q} b=${n.recon.carryOut.b}`,
        );
      } else {
        log(
          `Nachbartag ${formatDay(firstDay - 1)} nicht verfügbar: Minute 0 von ${formatDay(firstDay)} bleibt edge_pending`,
        );
      }
    }

    await this.processRange(firstDay, lastDay);

    // Kaskade (Review N2): ein gespeicherter Folgetag, der mit einem anderen Übertrag bzw. einer
    // anderen letzten aggId des Vortags klassifiziert wurde, wird in diesem Lauf mitgerechnet; ohne
    // Quelldateien wird er als veraltet (stale) markiert. Weiter als bis zur ersten unveränderten
    // Folgeminute ohne Kandidat reicht die Wirkung praktisch nie, daher endet die Kaskade dort.
    // Obergrenze der Kaskade. Ein Tag jenseits davon (Tag 8) ist trotzdem nicht stillschweigend
    // inkonsistent: der schreibende Lauf markiert jeden gespeicherten Folgetag mit geänderten
    // Vortagseingaben in derselben Transaktion als stale (H-b), der nächste Lauf rechnet ihn neu.
    const MAX_CASCADE = 7;
    for (let k = 1; ; k++) {
      if (k > MAX_CASCADE) {
        log(
          `WARNUNG: Kaskade nach ${MAX_CASCADE} Tagen abgebrochen; ${formatDay(lastDay + 1)} prüfen (--plan)`,
        );
        break;
      }
      const next = lastDay + 1;
      const st = await writer.storedDay(spec.name, next);
      const ch = this.chain!;
      if (!st || !(st.state === 'final_ok' || st.state === 'final_bad')) break;
      const why = inputsDiffer(st, ch);
      if (!why) break;
      if (!this.sourcesAvailable(next)) {
        await writer.markStale(next, why);
        log(
          `Folgetag ${formatDay(next)} veraltet (${why}), Quelldateien fehlen: als stale markiert`,
        );
        break;
      }
      log(`Kaskade ${k}: Folgetag ${formatDay(next)} wird neu klassifiziert (${why})`);
      lastDay = next;
      await this.processRange(next, next);
    }

    if (
      this.summaries.length !== lastDay - firstDay + 1 ||
      !this.chain ||
      this.chain.day !== lastDay
    ) {
      throw new Error(
        `Interner Fehler: ${this.summaries.length} von ${lastDay - firstDay + 1} Tagen verarbeitet`,
      );
    }

    // Folgetag des Bereichs: nur lesen, Minute 0 mit unserem Übertrag abgleichen.
    let nextOk = false;
    const lastChain = this.chain;
    if (this.o.neighbours) {
      const n = await this.analyseNeighbour(lastDay + 1, lastChain.prevIn);
      if (n) {
        nextOk = true;
        log(
          `Nachbartag ${formatDay(lastDay + 1)} gelesen: Minute 0 ${CLS[n.recon.ownCls[0]!]} (D_q=${n.recon.dQ[0]}, s_q=${n.recon.sQ[0]})`,
        );
        if (this.open) await this.settle(this.open, true);
        this.open = null;
        await this.resolve(lastDay + 1, 0, n.recon, n.inp);
      } else {
        log(
          `Nachbartag ${formatDay(lastDay + 1)} nicht verfügbar: Minute 1439 von ${formatDay(lastDay)} bleibt edge_pending`,
        );
      }
    }
    if (!nextOk && this.open) await this.settle(this.open, false);
    return this.summaries;
  }

  private sourcesAvailable(day: number): boolean {
    const { spec, dataDir, prefer } = this.o;
    return (
      resolveAggSource(dataDir, spec.name, day, prefer) !== null &&
      isPresent(absPath(dataDir, klineRef(spec.name, day)))
    );
  }

  private async processRange(firstDay: number, lastDay: number): Promise<void> {
    const { spec, dataDir, prefer } = this.o;
    // Quellen bestimmen und zu Läufen zusammenfassen (eine Monatsdatei = ein Lauf).
    const runs: { src: Source; days: number[] }[] = [];
    for (let d = firstDay; d <= lastDay; d++) {
      const src = resolveAggSource(dataDir, spec.name, d, prefer);
      if (!src) {
        throw new Error(
          `Keine aggTrades-Quelle für ${spec.name} ${formatDay(d)} (prefer=${prefer}); Datei + .CHECKSUM nötig`,
        );
      }
      const last = runs[runs.length - 1];
      if (last && last.src.path === src.path) last.days.push(d);
      else runs.push({ src, days: [d] });
    }

    for (const run of runs) {
      const v = await this.verify(run.src.path);
      const want = new Set(run.days);
      const lastWanted = run.days[run.days.length - 1]!;
      let tPrev = performance.now();
      let expectNext = run.src.ref.origin === 'monthly' ? run.src.firstDay : run.days[0]!;
      let headerPresent = false;
      const summary = await readAggTrades(run.src.path, spec, {
        onHeader: (h) => {
          headerPresent = h;
        },
        firstDay: run.src.firstDay,
        lastDay: run.src.lastDay,
        want: (d) => want.has(d),
        stopAfterDay: lastWanted,
        onDay: async (c) => {
          if (c.day !== expectNext) {
            throw new Error(
              `${run.src.rel}: Tag ${formatDay(expectNext)} fehlt in der Datei (nächster ist ${formatDay(c.day)})`,
            );
          }
          expectNext = c.day + 1;
          if (!c.agg) {
            // nicht angeforderter Tag vor dem Bereich (Monatsdatei); die Kette kommt vom Nachbartag
            tPrev = performance.now();
            return;
          }
          const readMs = performance.now() - tPrev;
          const t0 = performance.now();
          const kl = await this.readKlines(c.day);
          const data = buildDayData(spec, c.agg, kl.klines);
          const p: Prepared = {
            day: c.day,
            data,
            stats: c.stats,
            src: run.src,
            aggV: v,
            klineV: kl.v,
            klineRel: kl.rel,
            klineHeader: kl.headerPresent,
            headerPresent,
            readMs,
            buildMs: performance.now() - t0,
          };
          const linked: Chain | null =
            this.chain && this.chain.day === c.day - 1 ? this.chain : null;
          const continuesPrev =
            linked && linked.lastAggId !== null && c.stats.firstAggId !== null
              ? c.stats.firstAggId === linked.lastAggId + 1
              : null;
          const prevIn = linked ? linked.prevIn : undefined;
          // Abgleich des Tages; Minute 1439 bleibt offen, bis d+1 abgeglichen ist.
          const recon = reconcileDay(data.reconcileInput, { prev: prevIn, nextReconciled: false });
          const inputs: DayInputs = {
            carryIn: recon.carryIn,
            candIn: prevIn ? prevIn.cand : null,
            carryInOrigin: linked ? linked.origin : 'estimated',
            prevLastAggId: linked ? linked.lastAggId : null,
          };
          const w = await this.write(p, recon, continuesPrev, inputs);
          // Übersprungener Tag mit beim Schreiben unbekanntem Vortag → Minute 0 jetzt entscheiden
          if (w.summary.skipped && prevIn) await this.resolve(c.day, 0, recon, data.reconcileInput);
          if (this.open && this.open.day === c.day - 1) await this.settle(this.open, true);
          this.open = {
            day: c.day,
            inp: data.reconcileInput,
            prevIn,
            summary: w.summary,
            extraBad: w.extraBad,
          };
          this.chain = {
            day: c.day,
            prevIn: { carry: recon.carryOut, cand: recon.candLast },
            lastAggId: c.stats.lastAggId,
            origin: 'chain',
          };
          tPrev = performance.now();
        },
      });
      // Jeder angeforderte Tag muss gelesen worden sein (auch der letzte und bei leeren Dateien).
      if (expectNext !== lastWanted + 1) {
        throw new Error(
          `${run.src.rel}: Tag ${formatDay(expectNext)} fehlt in der Datei (angefordert bis ${formatDay(lastWanted)})`,
        );
      }
      if (
        summary.complete &&
        run.src.ref.origin === 'monthly' &&
        expectNext !== run.src.lastDay + 1
      ) {
        throw new Error(`${run.src.rel}: Monatsdatei endet vor ${formatDay(run.src.lastDay)}`);
      }
      if (this.o.sidecar && summary.complete) {
        await this.writeSidecar(run.src, v, summary);
      }
    }
  }

  /** Minute eines gespeicherten Tages mit bekannter Klasse entscheiden. */
  private async resolve(
    day: number,
    minute: number,
    recon: ReconcileResult,
    inp: ReconcileInput,
  ): Promise<void> {
    const done = await this.o.writer.resolveEdge({
      symbol: this.o.spec.name,
      symId: this.o.spec.symId,
      day,
      minute,
      decided: { cls: recon.ownCls[minute]!, facts: factsOf(recon, inp, minute) },
    });
    if (done) this.o.log(`Randminute ${minute} von ${formatDay(day)} in der DB aufgelöst`);
  }

  /**
   * Tag mit offener Minute 1439 abschließen: `nextReconciled` = Folgetag ist abgeglichen. Aktualisiert
   * die Zusammenfassung und entscheidet die Minute im Speicher.
   */
  private async settle(o: OpenDay, nextReconciled: boolean): Promise<void> {
    if (nextReconciled) {
      if (o.neighbourRecon) await this.resolve(o.day, 1439, o.neighbourRecon, o.inp);
      else if (!o.summary) {
        // gespeicherter Vortag: dessen gespeicherte eigene Klasse gilt
        const done = await this.o.writer.resolveEdge({
          symbol: this.o.spec.name,
          symId: this.o.spec.symId,
          day: o.day,
          minute: 1439,
        });
        if (done) this.o.log(`Randminute 1439 von ${formatDay(o.day)} in der DB aufgelöst`);
      }
    }
    const s = o.summary;
    if (!s) return;
    const recon = reconcileDay(o.inp, { prev: o.prevIn, nextReconciled });
    if (nextReconciled) await this.resolve(o.day, 1439, recon, o.inp);
    const issues: MinuteDetail[] = [];
    for (let m = 0; m < 1440; m++) {
      const c = recon.cls[m]!;
      if (c === 3 || c === 5) issues.push(minuteDetail(recon, o.inp, m));
    }
    s.counts = recon.counts;
    s.edges = [minuteDetail(recon, o.inp, 0), minuteDetail(recon, o.inp, 1439)];
    s.issues = issues;
    s.qualityDigest = qualityDigest(recon);
    s.state = stateOf(recon, o.extraBad);
    this.o.onDayData?.({ symbol: s.symbol, dayStr: s.day, reconcileInput: o.inp }, recon);
    this.o.onSummary?.(s);
    this.o.log(formatSummary(s));
  }

  private async write(
    p: Prepared,
    recon: ReconcileResult,
    continuesPrev: boolean | null,
    inputs: DayInputs,
  ): Promise<{ summary: DaySummary; extraBad: string[] }> {
    const { spec, writer, importerVersion } = this.o;
    const aggManifest = aggDayManifest(
      spec,
      p.day,
      p.src,
      p.aggV,
      p.stats,
      continuesPrev,
      p.headerPresent,
      importerVersion,
    );
    const klineManifest: DayManifest = {
      symbol: spec.name,
      kind: 'klines',
      day: formatDay(p.day),
      origin: 'daily',
      originPath: p.klineRel,
      originSha256: p.klineV.sha256,
      rows: p.data.klines.length,
      firstAggId: null,
      lastAggId: null,
      aggIdHoles: 0,
      aggIdDups: 0,
      tsBackwards: 0,
      continuesPrev: null,
      firstTs: p.data.klines[0]?.openTime ?? null,
      lastTs: p.data.klines[p.data.klines.length - 1]?.openTime ?? null,
      tradeIdGapSum: 0,
      tradeIdGapMax: 0,
      maxTimeGapMs: 0,
      headerPresent: p.klineHeader,
      downloadedAt: p.klineV.mtime,
      importerVersion,
    };
    const extraBad: string[] = [];
    if (p.stats.holes > 0) extraBad.push(`${p.stats.holes} aggId-Löcher`);
    if (continuesPrev === false) extraBad.push('aggIds nicht fortlaufend zum Vortag');
    const kref = klineRef(spec.name, p.day);
    const aggFile = fileManifest(p.src, p.aggV, p.headerPresent, 0, importerVersion, []);
    const klineFile = fileManifest(
      { rel: p.klineRel, ref: kref },
      p.klineV,
      p.klineHeader,
      p.data.klines.length,
      importerVersion,
      [klineManifest],
    );
    const t0 = performance.now();
    let outcome: WriteOutcome;
    // „Fertig" hängt von Daten ab, nicht vom Codetext (Review N3): der Tag ist bereits berechnet;
    // gleichen Daten-Digest, Klassen-Digest, Quelldateien und Vortagseingaben den gespeicherten,
    // wird nichts geschrieben (nur die Herkunft aktualisiert).
    const own = ownQualityDigest(recon);
    const st = await writer.storedDay(spec.name, p.day);
    const reasons = writeReasons(st, {
      digest: p.data.digest,
      quality: own,
      aggSha: p.aggV.sha256,
      klineSha: p.klineV.sha256,
      inputs,
    });
    if (this.o.force && reasons.length === 0) reasons.push('--force');
    let decision: DaySummary['decision'] = reasons.length === 0 ? 'skip' : 'write';
    // Ein Lauf mit schwächerem Übertrag (geschätzt) überschreibt keine mit bekanntem Übertrag
    // berechnete Klassifikation derselben Daten.
    if (
      decision === 'write' &&
      st?.inputs &&
      ORIGIN_RANK[inputs.carryInOrigin] < ORIGIN_RANK[st.inputs.carryInOrigin] &&
      reasons.every((r) => r === 'Klassifikation' || r === 'Vortagseingaben')
    ) {
      decision = 'keep';
    }
    const skipped = decision !== 'write';
    if (skipped) {
      outcome = { dbDigest: null, state: stateOf(recon, extraBad), version: null };
      if (decision === 'skip' && st && st.importerVersion !== importerVersion) {
        await writer.touchDay(p.day, importerVersion, RULES_VERSION);
      }
    } else {
      outcome = await writer.writeDay({
        data: p.data,
        recon,
        aggManifest,
        klineManifest,
        aggFile,
        klineFile,
        importerVersion,
        rulesVersion: RULES_VERSION,
        extraBad,
        inputs,
        qualityDigest: own,
      });
    }
    const writeMs = performance.now() - t0;
    const inp = p.data.reconcileInput;
    const fpRows: Record<string, number> = {};
    for (const [t, tab] of Object.entries(p.data.fp)) fpRows[t] = tab.n;
    const s: DaySummary = {
      symbol: spec.name,
      day: formatDay(p.day),
      aggSha256: p.aggV.sha256,
      klineSha256: p.klineV.sha256,
      importerVersion,
      origin: p.src.ref.origin,
      originPath: p.src.rel,
      rows: p.stats.rows,
      firstAggId: p.stats.firstAggId,
      lastAggId: p.stats.lastAggId,
      aggIdHoles: p.stats.holes,
      continuesPrev,
      fpRows,
      bars: p.data.bar_1m.length,
      candidates: p.data.agg.candCount,
      exactQ: recon.exactQ,
      exactB: recon.exactB,
      counts: recon.counts,
      carryIn: recon.carryIn,
      carryInKnown: recon.carryInKnown,
      carryInInferred: recon.carryInInferred,
      carryOut: recon.carryOut,
      totals: recon.totals,
      edges: [minuteDetail(recon, inp, 0), minuteDetail(recon, inp, 1439)],
      issues: [],
      ohlc: p.data.ohlc,
      minStepUnits: p.data.agg.minStepUnits,
      digest: p.data.digest,
      digests: p.data.digests,
      qualityDigest: qualityDigest(recon),
      ownQualityDigest: own,
      inputs,
      decision,
      reasons,
      manifest: comparableDayManifest(aggManifest),
      state: outcome.state,
      extraBad,
      skipped,
      dbDigest: outcome.dbDigest,
      timing: {
        readMs: Math.round(p.readMs),
        buildMs: Math.round(p.buildMs),
        writeMs: Math.round(writeMs),
        rowsPerSec: Math.round(p.stats.rows / ((p.readMs + p.buildMs + writeMs) / 1000)),
      },
    };
    this.summaries.push(s);
    return { summary: s, extraBad };
  }

  private async writeSidecar(
    src: Source,
    v: VerifiedFile,
    summary: Awaited<ReturnType<typeof readAggTrades>>,
  ): Promise<void> {
    const { spec, importerVersion } = this.o;
    const days: DayManifest[] = [];
    let prevLast: number | null = null;
    for (const d of summary.days) {
      const cp: boolean | null =
        prevLast !== null && d.stats.firstAggId !== null
          ? d.stats.firstAggId === prevLast + 1
          : null;
      days.push(
        aggDayManifest(spec, d.day, src, v, d.stats, cp, summary.headerPresent, importerVersion),
      );
      prevLast = d.stats.lastAggId;
    }
    // Tagesübergreifende Prüfungen einer Monatsdatei (§3.1)
    const sumRows = days.reduce((a, d) => a + d.rows, 0);
    if (sumRows !== summary.rows)
      throw new Error(`${src.rel}: Σ Tageszeilen ${sumRows} ≠ Dateizeilen ${summary.rows}`);
    const fm = fileManifest(src, v, summary.headerPresent, summary.rows, importerVersion, days);
    const sc = this.o.sidecar as { dir?: string };
    const target = sc.dir ? join(sc.dir, `${src.rel}.manifest.json`) : `${src.path}.manifest.json`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(fm, null, 2) + '\n');
  }
}

const fmtInt = (n: number) => n.toLocaleString('en-US');

export function formatSummary(s: DaySummary): string {
  const c = s.counts;
  const t = s.totals;
  const e0 = s.edges[0]!;
  const e1 = s.edges[1]!;
  return [
    `${s.symbol} ${s.day} [${s.origin}] rows=${fmtInt(s.rows)} ids=${s.firstAggId}..${s.lastAggId} holes=${s.aggIdHoles} cont=${s.continuesPrev ?? '?'} tradeIdGap max=${s.manifest.tradeIdGapMax} Σ=${s.manifest.tradeIdGapSum} maxTimeGap=${s.manifest.maxTimeGapMs}ms`,
    `  minutes exact=${c.exact} shift=${c.shift} mismatch=${c.mismatch} missing=${c.missing} edge_pending=${c.edge_pending} | D=0: vol ${s.exactQ}/1440, taker-buy ${s.exactB}/1440 | candidates=${s.candidates}`,
    `  Σvol ours=${t.ourQ} kline=${t.klQ} diff=${t.ourQ - t.klQ} | Σtaker ours=${t.ourB} kline=${t.klB} diff=${t.ourB - t.klB} | s(-1)=${s.carryIn.q}/${s.carryIn.b}${s.carryInKnown ? '' : ' (geschätzt)'} s(1439)=${s.carryOut.q}/${s.carryOut.b} identity=${t.identityQ && t.identityB} bounds=${t.carryBoundsOk}`,
    `  edge m0: ${e0.cls} (own ${e0.ownCls}, D=${e0.dQ}/${e0.dB}, s=${e0.sQ}/${e0.sB}) m1439: ${e1.cls} (own ${e1.ownCls}, D=${e1.dQ}/${e1.dB}, s=${e1.sQ}/${e1.sB}, cand=${e1.candQ}/${e1.candB})`,
    `  ohlc diff o/h/l/c=${s.ohlc.open}/${s.ohlc.high}/${s.ohlc.low}/${s.ohlc.close} of ${s.ohlc.compared} | fp_1m=${fmtInt(s.fpRows.fp_1m ?? 0)} bars=${s.bars} tick=${s.minStepUnits}`,
    `  state=${s.state}${s.extraBad.length ? ` (${s.extraBad.join('; ')})` : ''}${s.decision === 'write' ? ` WRITTEN(${s.reasons.join(', ')})` : s.decision === 'skip' ? ' UNCHANGED' : ` KEPT(${s.reasons.join(', ')})`} digest=${s.digest}${s.dbDigest ? ` db=${s.dbDigest === s.digest ? 'match' : s.dbDigest}` : ''}`,
    `  time read=${s.timing.readMs}ms build=${s.timing.buildMs}ms write=${s.timing.writeMs}ms → ${fmtInt(s.timing.rowsPerSec)} rows/s`,
  ].join('\n');
}
