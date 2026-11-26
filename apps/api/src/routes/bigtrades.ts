// GET /api/v1/bigtrades – Vertrag in docs/BIGTRADES-API.md.
//
// Ablauf: Parameter prüfen (wie /bars: tf, ausgerichtetes [from, to), höchstens MAX_BARS_PER_REQUEST
// Bars) → Schwelle in USDT ≥ Untergrenze des Symbols (sonst 422 mit minUsdt) → Abdeckung je Tag aus
// dem Katalog (Version vorab, 304) → Quellzeilen aus der Tageszahl der big_order-Zeilen (sonst 422
// mit suggestTo) → in einer Lesetransaktion (big_order-Chunks gesperrt): Order-Felder der Tage und
// die Orders ≥ Schwelle nur in Tagen mit Order-Daten, bei mehr als BIGTRADES_MAX_ROWS Zeilen je
// (Bar, Seite) die k größten.
import {
  encodeBigTrades,
  TIMEFRAMES,
  type BigTradeColumns,
  type BigTradesMeta,
} from '@orderflow/core';
import type { FastifyInstance } from 'fastify';
import { BIG_LADDER_USDT, coveragePlan, estimateBig } from '../bigtrades-plan.ts';
import { guardedRead, requireSymbol, type Deps } from '../context.ts';
import { badRequest, unprocessable } from '../errors.ts';
import { makeResponse } from '../http.ts';
import { checkRange, MAX_TIME_MS, Params, SYMBOL_RE } from '../params.ts';
import { coveredDays } from '../plan.ts';
import { queryBigOrders, readOrderDays } from '../queries.ts';
import { serveVersioned } from '../respond.ts';
import { versionOf } from '../versions.ts';

/** Höchstzahl Bars je Anfrage (wie /bars; der Client fragt Abschnitte zu 1 000 Bars an). */
export const BIGTRADES_MAX_BARS = 5_000;
/**
 * Höchstzahl Zeilen je Antwort. ≥ 2 · 2 · BIGTRADES_MAX_BARS: auch voll ausgedünnt bleiben je (Bar,
 * Seite) mindestens die 2 größten Orders – die Ausdünnung scheitert nie, ein 422 wegen der Antwortgröße
 * gibt es nicht.
 */
export const BIGTRADES_MAX_ROWS = 20_000;
/**
 * Höchstzahl gelesener (entpackter) big_order-Zeilen je Anfrage, unabhängig von der Schwelle.
 * Gemessen (apps/api/bench/bigtrades-plan.ts, Mac, Columnstore): ≈ 30 ms je Million → ≤ 150 ms; deckt
 * Abschnitte zu 1 000 Tagesbars bei ≈ 4 600 Orders/Tag (4,6 Mio.).
 */
export const BIGTRADES_MAX_SOURCE_ROWS = 5_000_000;
/**
 * Höchstzahl Orders ≥ Schwelle je Anfrage (geschätzt aus der Stufenstatistik des Katalogs). Über
 * BIGTRADES_MAX_ROWS werden alle gerankt (Sortierung, gemessen ≈ 0,9 µs je Treffer → ≤ 135 ms).
 */
export const BIGTRADES_MAX_MATCHED_ROWS = 150_000;
/** Größte Schwelle in USDT (keine Order erreicht sie; hält minN < 2^53). */
export const BIGTRADES_MAX_MIN_USDT = 1_000_000_000;
/** Version des Antwortaufbaus dieses Endpunkts (Teil der dataVersion). */
export const BIGTRADES_BUILD_VERSION = 1;

if (BIGTRADES_MAX_ROWS < 4 * BIGTRADES_MAX_BARS) throw new Error('BIGTRADES_MAX_ROWS zu klein');

const BIN = 'application/octet-stream';

export function registerBigTradesRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/bigtrades', async (req, reply) => {
    const p = new Params(req.query);
    const symName = p.str('sym', SYMBOL_RE);
    const tf = p.tf();
    const from = p.int('from', 0, MAX_TIME_MS);
    const to = p.int('to', 0, MAX_TIME_MS);
    const minUsdt = p.int('min', 1, BIGTRADES_MAX_MIN_USDT);
    p.done();
    const s = requireSymbol(deps, symName);
    const tfSec = TIMEFRAMES[tf];
    checkRange(from, to, tfSec * 1000, 'bigtrades');
    if ((to - from) / (tfSec * 1000) > BIGTRADES_MAX_BARS)
      throw badRequest(`höchstens ${BIGTRADES_MAX_BARS} Bars je Anfrage`);
    const big = s.big;
    if (!big)
      throw unprocessable(`Big Trades für ${s.name} nicht verfügbar (keine Untergrenze)`, {
        reason: 'not_available',
      });
    // Unter der Untergrenze gibt es keine gespeicherten Orders: ablehnen statt still anzuheben (eine
    // angehobene Schwelle wäre eine andere Antwort als die angefragte), mit der kleinsten gültigen.
    if (minUsdt < big.minUsdt)
      throw unprocessable(`Schwelle ${minUsdt} USDT unter der Untergrenze ${big.minUsdt} USDT`, {
        reason: 'below_floor',
        minUsdt: big.minUsdt,
        floorN: big.floorN,
      });
    const minN = Number(BigInt(minUsdt) * 10n ** BigInt(big.notionalDecimals));
    if (!Number.isSafeInteger(minN)) throw badRequest('Schwelle zu groß');
    const [d0, d1] = coveredDays(from, to);
    const parts = [
      'bigtrades',
      BIGTRADES_BUILD_VERSION,
      s.name,
      tf,
      from,
      to,
      minN,
      BIGTRADES_MAX_ROWS,
    ];
    const plan0 = coveragePlan(from, to, minN, (d) => s.days.get(d));
    const pre = {
      dataVersion: versionOf(parts, d0, d1, (d) => s.days.get(d)).dataVersion,
      final: plan0.final,
    };
    req.ctx.src = 'big_order';
    const histOn = (d: number) => s.stats.get(d)?.bigHist;
    const est = estimateBig(plan0.ranges, histOn, minUsdt);
    req.ctx.rowsEstimate = est.scanned;
    if (est.scanned > BIGTRADES_MAX_SOURCE_ROWS) {
      // Gelesen (entpackt) wird jede Zeile im Zeitraum, unabhängig von der Schwelle; Vorschlag: größtes
      // ausgerichtetes to ab from, dessen Schätzung in der Grenze liegt (Rest in Folgeanfragen).
      const step = tfSec * 1000;
      const scannedTo = (t: number) =>
        estimateBig(coveragePlan(from, t, minN, (d) => s.days.get(d)).ranges, histOn, minUsdt)
          .scanned;
      let lo = 1;
      let hi = (to - from) / step - 1;
      let best: number | null = null;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (scannedTo(from + m * step) <= BIGTRADES_MAX_SOURCE_ROWS) {
          best = from + m * step;
          lo = m + 1;
        } else hi = m - 1;
      }
      throw unprocessable(
        `Bereich zu groß (≈ ${est.scanned} big_order-Zeilen > ${BIGTRADES_MAX_SOURCE_ROWS}); kürzer anfragen`,
        {
          reason: 'source_rows_exceeded',
          rowsEstimate: est.scanned,
          limit: BIGTRADES_MAX_SOURCE_ROWS,
          suggestTo: best,
        },
      );
    }
    if (est.matched > BIGTRADES_MAX_MATCHED_ROWS) {
      // Treffer werden je (Bar, Seite) gerankt (Sortierung aller Treffer); Vorschlag: kleinste Stufe
      // über der Schwelle, deren (dort exakte) Trefferzahl in der Grenze liegt.
      const suggest =
        BIG_LADDER_USDT.find(
          (u) =>
            u > minUsdt &&
            estimateBig(plan0.ranges, histOn, u).matched <= BIGTRADES_MAX_MATCHED_ROWS,
        ) ?? null;
      throw unprocessable(
        `zu viele Orders ≥ ${minUsdt} USDT (≈ ${est.matched} > ${BIGTRADES_MAX_MATCHED_ROWS}); höhere Schwelle wählen`,
        {
          reason: 'matched_rows_exceeded',
          rowsEstimate: est.matched,
          limit: BIGTRADES_MAX_MATCHED_ROWS,
          suggestMinUsdt: suggest,
        },
      );
    }
    const key = `bigtrades|${s.name}|${tf}|${from}|${to}|${minN}`;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const { days, orders, plan } = await guardedRead(
        deps,
        ctx,
        async (tx) => {
          const days = await readOrderDays(tx, s.symId, d0, d1);
          // Abdeckung aus demselben Snapshot wie die Orders (nicht aus dem Katalog)
          const plan = coveragePlan(from, to, minN, (d) => days.get(d));
          const orders = await queryBigOrders(
            tx,
            s.symId,
            plan.ranges,
            tfSec,
            minN,
            BIGTRADES_MAX_ROWS,
          );
          return { days, orders, plan };
        },
        [{ table: 'big_order', from, to }],
      );
      const ver = versionOf(parts, d0, d1, (d) => days.get(d));
      if (ver.dataVersion !== pre.dataVersion) void deps.catalog.refresh();
      const n = orders.ts.length;
      if (orders.k === 0) throw new Error('Ausdünnung ohne Ergebnis (Grenzen inkonsistent)');
      const tfMs = tfSec * 1000;
      const rows: BigTradeColumns = {
        ts: Float64Array.from(orders.ts),
        bar: Int32Array.from(orders.ts, (t) => (t - (t % tfMs)) / 1000),
        side: Int32Array.from(orders.side),
        pxFirst: Int32Array.from(orders.pxFirst),
        pxLast: Int32Array.from(orders.pxLast),
        qty: Float64Array.from(orders.qty),
        notional: Float64Array.from(orders.notional),
        aggN: Int32Array.from(orders.aggN),
        firstAggId: Float64Array.from(orders.firstAggId),
      };
      const meta: BigTradesMeta = {
        kind: 'bigtrades',
        sym: s.name,
        tf,
        tfSec,
        priceDecimals: s.priceDecimals,
        qtyDecimals: s.qtyDecimals,
        tickRefUnits: s.tickRefUnits,
        notionalDecimals: big.notionalDecimals,
        from,
        to,
        minUsdt,
        minN,
        maxRows: BIGTRADES_MAX_ROWS,
        total: orders.total,
        omitted: orders.total - n,
        k: orders.total > n ? orders.k : null,
        coverage: plan.spans,
        dataVersion: ver.dataVersion,
        final: plan.final,
      };
      const u8 = encodeBigTrades({ meta, rows });
      const body = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
      return makeResponse(body, BIN, ver.dataVersion, plan.final, true);
    });
  });
}
