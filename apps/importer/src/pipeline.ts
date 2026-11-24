// Import-Ablauf für einen Tagesbereich eines Symbols (KONZEPT §3.1, §4.1, §4.3, §4.6):
// Quelle je Tag wählen (Tagesdatei oder Tagesanteil der Monatsdatei), SHA256 prüfen, streamen,
// je Tag aggregieren, Klines lesen, abgleichen (Übertrag über Tagesgrenzen, auch über
// Monatsgrenzen), Manifest bilden, schreiben. Tag d wird erst geschrieben, wenn Tag d+1
// abgeglichen ist (dann steht Minute 1439 fest); an den Bereichsrändern werden die Nachbartage nur
// gelesen (nicht geschrieben), sofern ihre Dateien vorliegen.
import {
  buildDayData,
  buildReconcileInput,
  comparableDayManifest,
  formatDay,
  monthDays,
  monthOfDay,
  qualityDigest,
  reconcileDay,
  type DayData,
  type DayManifest,
  type DayStats,
  type FileManifest,
  type NeighbourIn,
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
import { stateOf, type DayWriter, type WriteOutcome } from './writer/types.ts';

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
  /** Optional: je geschriebenem Tag die vollständigen Daten (Tests, Golden-Vergleiche). */
  onDayData?: (data: DayData, recon: ReconcileResult) => void;
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
  manifest: ReturnType<typeof comparableDayManifest>;
  state: 'final_ok' | 'final_bad';
  extraBad: string[];
  skipped: boolean;
  dbDigest: string | null;
  timing: { readMs: number; buildMs: number; writeMs: number; rowsPerSec: number };
}

const CLS = ['', 'exact', 'shift', 'mismatch', 'edge_pending', 'missing'];

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

  /** Nachbartag nur lesen und abgleichen (nicht schreiben). null, wenn Dateien fehlen. */
  private async analyseNeighbour(day: number, prev?: NeighbourIn) {
    const { spec, dataDir } = this.o;
    // Nachbartage aus der besten verfügbaren Quelle (Tages- und Monatsdatei sind gleichwertig, §3.1).
    const src = resolveAggSource(dataDir, spec.name, day, 'auto');
    const kref = klineRef(spec.name, day);
    if (!src || !isPresent(absPath(dataDir, kref))) return null;
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
    if (!chunk?.agg) return null;
    const kl = await this.readKlines(day);
    const inp = buildReconcileInput(chunk.agg, kl.klines);
    const recon = reconcileDay(inp, { prev, nextReconciled: true });
    return { recon, stats: chunk.stats, src, inp };
  }

  async run(): Promise<DaySummary[]> {
    const { spec, dataDir, firstDay, lastDay, prefer, writer, log } = this.o;
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

    let chain: Chain | null = null;
    let pendingPrevEdge: {
      day: number;
      recon: ReconcileResult;
      cand: { candQ: Float64Array; candB: Float64Array };
    } | null = null;
    if (this.o.neighbours) {
      const n = await this.analyseNeighbour(firstDay - 1);
      if (n) {
        chain = {
          day: firstDay - 1,
          prevIn: { carry: n.recon.carryOut, cand: n.recon.candLast },
          lastAggId: n.stats.lastAggId,
        };
        pendingPrevEdge = { day: firstDay - 1, recon: n.recon, cand: n.inp };
        log(
          `Nachbartag ${formatDay(firstDay - 1)} gelesen: Übertrag s(1439) q=${n.recon.carryOut.q} b=${n.recon.carryOut.b}`,
        );
      } else {
        log(
          `Nachbartag ${formatDay(firstDay - 1)} nicht verfügbar: Minute 0 von ${formatDay(firstDay)} bleibt edge_pending`,
        );
      }
    }

    let held: {
      p: Prepared;
      prevIn: NeighbourIn | undefined;
      continuesPrev: boolean | null;
    } | null = null;

    const flushHeld = async (nextReconciled: boolean) => {
      if (!held) return;
      const h = held;
      held = null;
      const recon = reconcileDay(h.p.data.reconcileInput, { prev: h.prevIn, nextReconciled });
      await this.write(h.p, recon, h.continuesPrev);
      if (pendingPrevEdge && pendingPrevEdge.day === h.p.day - 1) {
        const pe = pendingPrevEdge;
        pendingPrevEdge = null;
        const done = await writer.resolveEdge({
          symbol: spec.name,
          symId: spec.symId,
          day: pe.day,
          minute: 1439,
          recon: pe.recon,
          cand: pe.cand,
        });
        if (done) log(`Randminute 1439 von ${formatDay(pe.day)} in der DB aufgelöst`);
      }
    };

    for (const run of runs) {
      const v = await this.verify(run.src.path);
      const want = new Set(run.days);
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
        stopAfterDay: run.days[run.days.length - 1]!,
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
          const linked: Chain | null = chain && chain.day === c.day - 1 ? chain : null;
          const continuesPrev =
            linked && linked.lastAggId !== null && c.stats.firstAggId !== null
              ? c.stats.firstAggId === linked.lastAggId + 1
              : null;
          const prevIn = linked ? linked.prevIn : undefined;
          // Abgleich des Tages (Minute 1439 vorerst offen) liefert den Übertrag für den Folgetag.
          const recon = reconcileDay(data.reconcileInput, { prev: prevIn, nextReconciled: false });
          await flushHeld(held !== null && held.p.day === c.day - 1);
          held = { p, prevIn, continuesPrev };
          chain = {
            day: c.day,
            prevIn: { carry: recon.carryOut, cand: recon.candLast },
            lastAggId: c.stats.lastAggId,
          };
          tPrev = performance.now();
        },
      });
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

    // Folgetag des Bereichs: nur lesen, Minute 0 mit unserem Übertrag abgleichen.
    let nextOk = false;
    const lastChain = chain as Chain | null;
    if (this.o.neighbours && held && lastChain) {
      const n = await this.analyseNeighbour(lastDay + 1, lastChain.prevIn);
      if (n) {
        nextOk = true;
        log(
          `Nachbartag ${formatDay(lastDay + 1)} gelesen: Minute 0 ${CLS[n.recon.ownCls[0]!]} (D_q=${n.recon.dQ[0]}, s_q=${n.recon.sQ[0]})`,
        );
        await flushHeld(true);
        const done = await writer.resolveEdge({
          symbol: spec.name,
          symId: spec.symId,
          day: lastDay + 1,
          minute: 0,
          recon: n.recon,
          cand: n.inp,
        });
        if (done) log(`Randminute 0 von ${formatDay(lastDay + 1)} in der DB aufgelöst`);
      } else {
        log(
          `Nachbartag ${formatDay(lastDay + 1)} nicht verfügbar: Minute 1439 von ${formatDay(lastDay)} bleibt edge_pending`,
        );
      }
    }
    if (!nextOk) await flushHeld(false);
    return this.summaries;
  }

  private async write(
    p: Prepared,
    recon: ReconcileResult,
    continuesPrev: boolean | null,
  ): Promise<void> {
    const { spec, writer, importerVersion, log } = this.o;
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
    let skipped = false;
    if (await writer.isDone(spec.name, p.day, p.aggV.sha256, importerVersion)) {
      skipped = true;
      outcome = { dbDigest: null, state: stateOf(recon, extraBad), version: null };
    } else {
      outcome = await writer.writeDay({
        data: p.data,
        recon,
        aggManifest,
        klineManifest,
        aggFile,
        klineFile,
        importerVersion,
        extraBad,
      });
    }
    const writeMs = performance.now() - t0;
    const inp = p.data.reconcileInput;
    const issues: MinuteDetail[] = [];
    for (let m = 0; m < 1440; m++) {
      const c = recon.cls[m]!;
      if (c === 3 || c === 5) issues.push(minuteDetail(recon, inp, m));
    }
    const fpRows: Record<string, number> = {};
    for (const [t, tab] of Object.entries(p.data.fp)) fpRows[t] = tab.n;
    const s: DaySummary = {
      symbol: spec.name,
      day: formatDay(p.day),
      aggSha256: p.aggV.sha256,
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
      issues,
      ohlc: p.data.ohlc,
      minStepUnits: p.data.agg.minStepUnits,
      digest: p.data.digest,
      digests: p.data.digests,
      qualityDigest: qualityDigest(recon),
      manifest: comparableDayManifest(aggManifest),
      state: outcome.state,
      extraBad,
      skipped,
      dbDigest: outcome.dbDigest,
      timing: {
        readMs: Math.round(p.readMs),
        buildMs: Math.round(p.buildMs),
        writeMs: Math.round(writeMs),
        rowsPerSec: Math.round(p.stats.rows / ((p.readMs + p.buildMs) / 1000)),
      },
    };
    this.summaries.push(s);
    this.o.onDayData?.(p.data, recon);
    log(formatSummary(s));
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
    `  state=${s.state}${s.extraBad.length ? ` (${s.extraBad.join('; ')})` : ''}${s.skipped ? ' SKIPPED(resume)' : ''} digest=${s.digest}${s.dbDigest ? ` db=${s.dbDigest === s.digest ? 'match' : s.dbDigest}` : ''}`,
    `  time read=${s.timing.readMs}ms build=${s.timing.buildMs}ms write=${s.timing.writeMs}ms → ${fmtInt(s.timing.rowsPerSec)} rows/s`,
  ].join('\n');
}
