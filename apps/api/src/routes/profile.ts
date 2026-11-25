// GET /api/v1/profile und /api/v1/profiles/daily – Vertrag in docs/PROFILE-API.md.
//
// Ablauf: Parameter prüfen → Zeitraum zerlegen (plan.ts) → Quellzeilen schätzen (Statistik je Tag)
// → über der Grenze 422 mit Vorschlag für R → in einer Lesetransaktion: Tagesstände, Preisbereich und
// Summen aus den Bar-Tabellen (Zellschätzung vor der Level-Abfrage, sonst 422) → Level-Summen →
// dichte Zeilen, Summenprobe (Σ Level = Σ Bars, sonst 500), POC/VA/Delta-POC.
import {
  formatDay,
  profileMarks,
  PROFILE_FORMAT,
  type DailyProfile,
  type DailyProfilesResponse,
  type ProfileBody,
  type RangeProfileResponse,
} from '@orderflow/core';
import type { FastifyInstance } from 'fastify';
import { rowsOnFor, type SymbolState } from '../catalog.ts';
import { guardedRead, requireSymbol, type Deps } from '../context.ts';
import { badRequest, HttpError, unprocessable } from '../errors.ts';
import { makeResponse } from '../http.ts';
import {
  checkRange,
  DAY_MS,
  HOUR_MS,
  isLadderR,
  MAX_TIME_MS,
  MINUTE_MS,
  Params,
  SYMBOL_RE,
} from '../params.ts';
import {
  barSegmentsFor,
  coveredDays,
  decomposeDays,
  decomposeRange,
  estimateSegments,
  type Segment,
} from '../plan.ts';
import {
  queryProfileBars,
  queryProfileLevels,
  readDays,
  type ProfileBarRow,
  type ProfileLevelRow,
} from '../queries.ts';
import { serveVersioned } from '../respond.ts';
import { versionOf } from '../versions.ts';
import { allImmutable, checkCoverage, checkProfile } from '../consistency.ts';

/** Größte Zeilengröße eines Profils in Ticks. */
export const PROFILE_MAX_R = 1_000_000;
export const DEFAULT_VA = 70;
/** Höchstzahl Tage je Tagesprofil-Anfrage. */
export const MAX_DAILY_DAYS = 400;
/** Längster Zeitraum eines Range-Profils. */
export const MAX_RANGE_MS = 3_660 * DAY_MS;

interface Plan {
  segs: Segment[];
  barSegs: ReturnType<typeof barSegmentsFor>;
  estimate: number;
}

function planFor(s: SymbolState, R: number, from: number, to: number, daily: boolean): Plan {
  const segs = daily ? decomposeDays(from, to, R) : decomposeRange(from, to, R);
  const barSegs = barSegmentsFor(segs);
  const rowsOn = rowsOnFor(s);
  return {
    segs,
    barSegs,
    estimate: estimateSegments(segs, rowsOn) + estimateSegments(barSegs, rowsOn),
  };
}

function checkR(s: SymbolState, R: number): void {
  if (!isLadderR(R)) throw badRequest(`R=${R} liegt nicht auf der Leiter {1, 2, 5}·10^k`);
  if (R * s.tickRefUnits < s.tickUnits)
    throw badRequest(
      `R=${R} ist feiner als der aktuelle Tick (${s.tickUnits / s.tickRefUnits} Ticks)`,
    );
}

/** Kleinste Leiterstufe ≥ R, für die Quellzeilen und Zellen in den Grenzen liegen. */
function suggestR(
  deps: Deps,
  s: SymbolState,
  R: number,
  from: number,
  to: number,
  daily: boolean,
  cellsAt: ((R: number) => number) | null,
): number | null {
  for (let p = 1; p <= PROFILE_MAX_R; p *= 10) {
    for (const m of [1, 2, 5]) {
      const r = m * p;
      if (r <= R || r > PROFILE_MAX_R) continue;
      if (planFor(s, r, from, to, daily).estimate > deps.cfg.maxSourceRows) continue;
      if (cellsAt && cellsAt(r) > deps.cfg.maxCells) continue;
      return r;
    }
  }
  return null;
}

const rowOf = (px: number, w: number) => (px - (px % w)) / w;

/** VWAP in price_unit (Gleitkomma, 6 Nachkommastellen exakt per BigInt-Division); null ohne Volumen. */
export function vwapOf(notional: bigint, lots: number): number | null {
  if (lots <= 0) return null;
  return Number((notional * 1_000_000n) / BigInt(lots)) / 1_000_000;
}

/** Dichtes Profil aus Bars (Bereich, Summen) und Level-Zeilen [i0, i1) eines Tages bzw. Bereichs. */
function buildBody(
  bar: ProfileBarRow | undefined,
  lv: ProfileLevelRow[],
  i0: number,
  i1: number,
  w: number,
  va: number,
): ProfileBody {
  if (!bar) {
    if (i1 > i0) throw new Error('Level ohne Bars');
    return {
      rowLo: null,
      buy: [],
      sell: [],
      poc: null,
      vah: null,
      val: null,
      deltaPoc: null,
      buyQ: 0,
      sellQ: 0,
      notional: '0',
      vwap: null,
      low: null,
      high: null,
    };
  }
  const rowLo = rowOf(bar.low, w);
  const n = rowOf(bar.high, w) - rowLo + 1;
  const buy = new Array<number>(n).fill(0);
  const sell = new Array<number>(n).fill(0);
  let sb = 0;
  let ss = 0;
  for (let i = i0; i < i1; i++) {
    const l = lv[i]!;
    const k = l.row - rowLo;
    if (k < 0 || k >= n) throw new Error(`Zeile ${l.row} außerhalb [${rowLo}, ${rowLo + n - 1}]`);
    buy[k] = l.buy;
    sell[k] = l.sell;
    sb += l.buy;
    ss += l.sell;
  }
  // Exaktheitsprobe: Footprint-Summen = Bar-Summen (beide aus denselben aggTrades)
  if (sb !== bar.buyQ || ss !== bar.sellQ)
    throw new Error(`Level-Summen ${sb}/${ss} ≠ Bar-Summen ${bar.buyQ}/${bar.sellQ}`);
  return {
    rowLo,
    buy,
    sell,
    ...profileMarks(rowLo, buy, sell, va),
    buyQ: sb,
    sellQ: ss,
    notional: bar.notional.toString(),
    vwap: vwapOf(bar.notional, sb + ss),
    low: bar.low,
    high: bar.high,
  };
}

function envelope(s: SymbolState, R: number, from: number, to: number, va: number) {
  return {
    format: PROFILE_FORMAT,
    sym: s.name,
    R,
    priceDecimals: s.priceDecimals,
    qtyDecimals: s.qtyDecimals,
    tickRefUnits: s.tickRefUnits,
    from,
    to,
    va,
  };
}

export function registerProfileRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/profile', async (req, reply) => {
    const p = new Params(req.query);
    const symName = p.str('sym', SYMBOL_RE);
    const from = p.int('from', 0, MAX_TIME_MS);
    const to = p.int('to', 0, MAX_TIME_MS);
    const R = p.int('R', 1, PROFILE_MAX_R);
    const va = p.int('va', 1, 100, DEFAULT_VA);
    p.done();
    const s = requireSymbol(deps, symName);
    checkR(s, R);
    checkRange(from, to, MINUTE_MS, 'profile');
    if (to - from > MAX_RANGE_MS) throw badRequest('Zeitraum zu lang');
    const plan = planFor(s, R, from, to, false);
    req.ctx.rowsEstimate = plan.estimate;
    req.ctx.src = [...new Set(plan.segs.map((g) => g.table))].join('+');
    if (plan.estimate > deps.cfg.maxSourceRows) {
      throw unprocessable(
        `≈ ${plan.estimate} Quellzeilen > ${deps.cfg.maxSourceRows}; gröberes R wählen`,
        {
          reason: 'profile_source_rows',
          rowsEstimate: plan.estimate,
          limit: deps.cfg.maxSourceRows,
          suggestR: suggestR(deps, s, R, from, to, false, null),
        },
      );
    }
    const [d0, d1] = coveredDays(from, to);
    const parts = ['profile', s.name, from, to, R, va];
    const pre = versionOf(parts, d0, d1, (d) => s.days.get(d));
    const key = `profile|${parts.join('|')}`;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const w = R * s.tickRefUnits;
      const { days, bars, levels } = await guardedRead(
        deps,
        ctx,
        async (tx) => {
          const days = await readDays(tx, s.symId, d0, d1);
          const bars = await queryProfileBars(tx, s.symId, plan.barSegs, null);
          const b = bars[0];
          if (b) {
            const cells = rowOf(b.high, w) - rowOf(b.low, w) + 1;
            if (cells > deps.cfg.maxCells) {
              throw unprocessable(`${cells} Zeilen > ${deps.cfg.maxCells}; gröberes R wählen`, {
                reason: 'profile_rows',
                rows: cells,
                limit: deps.cfg.maxCells,
                suggestR: suggestR(deps, s, R, from, to, false, (r) => {
                  const x = r * s.tickRefUnits;
                  return rowOf(b.high, x) - rowOf(b.low, x) + 1;
                }),
              });
            }
          }
          const levels = b
            ? await queryProfileLevels(tx, s.symId, plan.segs, w, s.tickRefUnits, null)
            : [];
          const imm = allImmutable(days, d0, d1);
          const where = { sym: s.name, d0, d1, R };
          checkProfile(bars, levels, imm, where);
          // ein leeres Range-Profil über einem Zeitraum, der Trades haben müsste → Snapshot unbrauchbar
          const minutesOn = (d: number) => rowsOnFor(s)('bar_1m', d);
          checkCoverage(bars.length > 0 ? [from] : [], from, to, minutesOn, imm, where, true);
          return { days, bars, levels };
        },
        [...plan.segs, ...plan.barSegs],
      );
      const ver = versionOf(parts, d0, d1, (d) => days.get(d));
      if (ver.dataVersion !== pre.dataVersion) void deps.catalog.refresh();
      const out: RangeProfileResponse = {
        ...envelope(s, R, from, to, va),
        kind: 'profile',
        dataVersion: ver.dataVersion,
        final: ver.final,
        sources: plan.segs,
        sourceRowsEstimate: plan.estimate,
        profile: buildBody(bars[0], levels, 0, levels.length, w, va),
      };
      const body = Buffer.from(JSON.stringify(out));
      return makeResponse(body, 'application/json', ver.dataVersion, ver.final, true);
    });
  });

  app.get('/api/v1/profiles/daily', async (req, reply) => {
    const p = new Params(req.query);
    const symName = p.str('sym', SYMBOL_RE);
    const from = p.int('from', 0, MAX_TIME_MS);
    const to = p.int('to', 0, MAX_TIME_MS);
    const R = p.int('R', 1, PROFILE_MAX_R);
    const offsetH = p.int('offsetH', -23, 23, 0);
    const va = p.int('va', 1, 100, DEFAULT_VA);
    p.done();
    const s = requireSymbol(deps, symName);
    checkR(s, R);
    const off = offsetH * HOUR_MS;
    if (from - off < 0) throw badRequest('from vor dem ersten Tag');
    checkRange(from - off, to - off, DAY_MS, 'profiles/daily (Tagesgrenzen mit offsetH)');
    if ((to - from) / DAY_MS > MAX_DAILY_DAYS) throw badRequest(`höchstens ${MAX_DAILY_DAYS} Tage`);
    const plan = planFor(s, R, from, to, true);
    req.ctx.rowsEstimate = plan.estimate;
    req.ctx.src = [...new Set(plan.segs.map((g) => g.table))].join('+');
    if (plan.estimate > deps.cfg.maxSourceRows) {
      throw unprocessable(
        `≈ ${plan.estimate} Quellzeilen > ${deps.cfg.maxSourceRows}; gröberes R wählen`,
        {
          reason: 'profile_source_rows',
          rowsEstimate: plan.estimate,
          limit: deps.cfg.maxSourceRows,
          suggestR: suggestR(deps, s, R, from, to, true, null),
        },
      );
    }
    const [d0, d1] = coveredDays(from, to);
    const parts = ['daily', s.name, from, to, R, offsetH, va];
    const pre = versionOf(parts, d0, d1, (d) => s.days.get(d));
    const key = `daily|${parts.join('|')}`;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const w = R * s.tickRefUnits;
      const cellsOf = (bars: ProfileBarRow[], x: number) =>
        bars.reduce((a, b) => a + rowOf(b.high, x) - rowOf(b.low, x) + 1, 0);
      const { days, bars, levels } = await guardedRead(
        deps,
        ctx,
        async (tx) => {
          const days = await readDays(tx, s.symId, d0, d1);
          const bars = await queryProfileBars(tx, s.symId, plan.barSegs, off);
          const cells = cellsOf(bars, w);
          if (cells > deps.cfg.maxCells) {
            throw unprocessable(`${cells} Zeilen > ${deps.cfg.maxCells}; gröberes R wählen`, {
              reason: 'profile_rows',
              rows: cells,
              limit: deps.cfg.maxCells,
              suggestR: suggestR(deps, s, R, from, to, true, (r) =>
                cellsOf(bars, r * s.tickRefUnits),
              ),
            });
          }
          const levels =
            bars.length > 0
              ? await queryProfileLevels(tx, s.symId, plan.segs, w, s.tickRefUnits, off)
              : [];
          const imm = allImmutable(days, d0, d1);
          const where = { sym: s.name, d0, d1, R };
          checkProfile(bars, levels, imm, where);
          // je Tagesprofil: ein leerer Tag, der Trades haben müsste → Snapshot unbrauchbar
          const minutesOn = (d: number) => rowsOnFor(s)('bar_1m', d);
          const have = new Set(bars.map((b) => b.day));
          for (let a = from; a < to; a += DAY_MS) {
            if (!have.has(Math.floor((a - off) / DAY_MS)))
              checkCoverage([], a, a + DAY_MS, minutesOn, imm, where, true);
          }
          return { days, bars, levels };
        },
        [...plan.segs, ...plan.barSegs],
      );
      const ver = versionOf(parts, d0, d1, (d) => days.get(d));
      if (ver.dataVersion !== pre.dataVersion) void deps.catalog.refresh();
      const out: DailyProfile[] = [];
      let i = 0;
      for (const b of bars) {
        while (i < levels.length && levels[i]!.day < b.day) {
          throw new HttpError(500, `Level am Tag ${levels[i]!.day} ohne Bars`);
        }
        let j = i;
        while (j < levels.length && levels[j]!.day === b.day) j++;
        const dayFrom = b.day * DAY_MS + off;
        // überdeckte UTC-Tage des Tagesprofils
        const u0 = Math.floor(dayFrom / DAY_MS);
        const u1 = Math.floor((dayFrom + DAY_MS - 1) / DAY_MS);
        const dv = versionOf(['daily-day', s.name, dayFrom, R, va], u0, u1, (d) => days.get(d));
        out.push({
          day: formatDay(b.day),
          from: dayFrom,
          to: dayFrom + DAY_MS,
          final: dv.final,
          dataVersion: dv.dataVersion,
          ...buildBody(b, levels, i, j, w, va),
        });
        i = j;
      }
      if (i !== levels.length) throw new HttpError(500, 'Level ohne Bars');
      // Tage ohne Profil unterscheiden: mit Daten, aber ohne Trades (leer) vs. ohne Daten (fehlend)
      const withProfile = new Set(bars.map((b) => b.day));
      const emptyDays: string[] = [];
      const missingDays: string[] = [];
      for (let a = from; a < to; a += DAY_MS) {
        const dd = Math.floor((a - off) / DAY_MS);
        if (withProfile.has(dd)) continue;
        const u0 = Math.floor(a / DAY_MS);
        const u1 = Math.floor((a + DAY_MS - 1) / DAY_MS);
        let any = false;
        for (let u = u0; u <= u1; u++) if (days.has(u)) any = true;
        (any ? emptyDays : missingDays).push(formatDay(dd));
      }
      const res: DailyProfilesResponse = {
        ...envelope(s, R, from, to, va),
        kind: 'profiles/daily',
        offsetH,
        dataVersion: ver.dataVersion,
        final: ver.final,
        sources: plan.segs,
        sourceRowsEstimate: plan.estimate,
        days: out,
        emptyDays,
        missingDays,
      };
      const body = Buffer.from(JSON.stringify(res));
      return makeResponse(body, 'application/json', ver.dataVersion, ver.final, true);
    });
  });
}
