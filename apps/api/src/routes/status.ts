// GET /api/v1/quality (KONZEPT §4.9; Vertrag in docs/PROFILE-API.md, Abschnitt Qualität) und
// GET /api/v1/health (öffentlich nur {status}); die ausführliche Antwort liefert der getrennte
// Status-Listener auf 127.0.0.1 (KONZEPT §2.5; Recorder-, Platten- und Uhrprüfung folgen mit P2).
import { formatDay } from '@orderflow/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { guardedRead, requireSymbol, type Deps } from '../context.ts';
import { badRequest } from '../errors.ts';
import { makeResponse } from '../http.ts';
import { serveVersioned } from '../respond.ts';
import { qualityVersion } from '../versions.ts';
import { DAY_MS, MAX_TIME_MS, Params, SYMBOL_RE } from '../params.ts';
import { coveredDays } from '../plan.ts';
import { queryIssues, queryQualityDays } from '../queries.ts';

export const QUALITY_SCHEMA = 1;
/** Höchstens so viele Tage je Anfrage (eine Anfrage hält den Limiter-Platz nur kurz). */
export const MAX_QUALITY_DAYS = 400;
/** Höchstens so viele Issue-Minuten je Antwort; weitere Seiten über issuesFrom = issuesNext. */
export const MAX_ISSUES = 5_000;

/** Gründe, warum die API nicht gesund ist (leer = gesund). */
/**
 * Gesundheit: unhealthy (503), wenn der Katalog fehlt, die Datenbank nicht erreichbar ist oder die
 * Aktualisierung hängt; degraded (200), wenn sie nur an Sperren/Zeitlimits eines laufenden Imports
 * scheitert (der letzte Stand bleibt gültig, die API bedient weiter).
 */
function health(deps: Deps): { state: 'healthy' | 'degraded' | 'unhealthy'; reasons: string[] } {
  const reasons: string[] = [];
  const cat = deps.catalog;
  if (!cat.ready) return { state: 'unhealthy', reasons: ['Katalog noch nicht geladen'] };
  const age = Date.now() - cat.lastRefresh;
  let bad = false;
  if (age > 3 * deps.cfg.staleAfterMs) {
    bad = true;
    reasons.push(`Katalog seit ${Math.round(age / 1000)} s nicht aktualisiert`);
  }
  if (cat.lastError) {
    reasons.push(`Datenbank (${cat.lastErrorKind ?? 'other'}): ${cat.lastError}`);
    if (cat.lastErrorKind === 'connection' || cat.lastErrorKind === 'other') {
      if (age > deps.cfg.staleAfterMs) bad = true;
    }
  }
  for (const e of cat.dataErrors.slice(-5))
    reasons.push(`Datenfehler ${e.sym ?? ''} ${e.message} (${new Date(e.at).toISOString()})`);
  return { state: bad ? 'unhealthy' : reasons.length > 0 ? 'degraded' : 'healthy', reasons };
}

/** Ausführliche Health-Antwort – nur auf dem Loopback-Status-Listener (buildAdminApp). */
export function healthDetail(deps: Deps, startedAt: number, reply: FastifyReply): FastifyReply {
  const { state, reasons } = health(deps);
  const cat = deps.catalog;
  const mem = process.memoryUsage();
  reply.header('Cache-Control', 'no-store');
  return reply.code(state === 'unhealthy' ? 503 : 200).send({
    status: state,
    reasons,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    catalog: {
      ready: cat.ready,
      ageMs: cat.lastRefresh > 0 ? Date.now() - cat.lastRefresh : null,
      lastError: cat.lastError,
    },
    symbols: cat.symbols().map((x) => ({
      name: x.name,
      dataFrom: x.dataFrom,
      dataTo: x.dataTo,
      days: x.days.size,
      tileConfigVersion: x.tileConfigVersion,
    })),
    cache: deps.cache.stats(),
    limiter: {
      running: deps.limiter.running,
      waiting: deps.limiter.waiting,
      rejected: deps.limiter.rejected,
    },
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external },
  });
}

export function registerStatusRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/quality', async (req, reply) => {
    const p = new Params(req.query);
    const symName = p.str('sym', SYMBOL_RE);
    const from = p.int('from', 0, MAX_TIME_MS);
    const to = p.int('to', 0, MAX_TIME_MS);
    const withShift = p.int('shift', 0, 1, 0) === 1;
    const issuesFrom = p.int('issuesFrom', 0, MAX_TIME_MS, 0);
    p.done();
    const s = requireSymbol(deps, symName);
    if (to <= from) throw badRequest('to muss größer als from sein');
    const [d0, d1] = coveredDays(from, to);
    if (d1 - d0 + 1 > MAX_QUALITY_DAYS) throw badRequest(`höchstens ${MAX_QUALITY_DAYS} Tage`);
    // apiDataErrors gehören zur Antwort: Anzahl und jüngster Zeitpunkt gehen in die Version ein
    const de = deps.catalog.dataErrors;
    const parts = [
      'quality',
      s.name,
      withShift ? 1 : 0,
      issuesFrom,
      `de${de.length}:${de.at(-1)?.at ?? 0}`,
    ];
    const fpNow = (d: number) => s.days.get(d)?.quality;
    // Qualität ist nie final (kann sich ändern, solange ein Tag nicht neu importiert wird): Browser
    // no-cache, Server-Cache höchstens nonFinalTtlMs, Schlüssel = Fingerabdruck aller Qualitätsfelder.
    const pre = { dataVersion: qualityVersion(parts, d0, d1, fpNow), final: false };
    const key = `quality|${parts.join('|')}|${d0}|${d1}`;
    return serveVersioned(deps, req, reply, key, pre, async (ctx) => {
      const lo = Math.max(d0 * DAY_MS, issuesFrom);
      const { days, issues } = await guardedRead(deps, ctx, async (tx) => ({
        days: await queryQualityDays(tx, s.symId, d0, d1),
        issues: await queryIssues(tx, s.symId, lo, (d1 + 1) * DAY_MS, withShift, MAX_ISSUES),
      }));
      const fps = new Map(days.map((d) => [d.day, d.fp]));
      const version = qualityVersion(parts, d0, d1, (d) => fps.get(d));
      if (version !== pre.dataVersion) void deps.catalog.refresh();
      const body = Buffer.from(
        JSON.stringify({
          schema: QUALITY_SCHEMA,
          kind: 'quality',
          sym: s.name,
          from: d0 * DAY_MS,
          to: (d1 + 1) * DAY_MS,
          days: days.map(({ fp: _fp, ...d }) => ({
            ...d,
            day: formatDay(d.day),
            from: d.day * DAY_MS,
          })),
          issues: issues.issues,
          issuesIncludeShift: withShift,
          issuesFrom: lo,
          issuesNext: issues.next,
          issuesTruncated: issues.next !== null,
          // Datenfehler, die die API seit ihrem Start auf unveränderlichen Tagen dieses Bereichs fand
          apiDataErrors: deps.catalog.dataErrors
            .filter((e) => e.sym === s.name && (e.d1 ?? d1) >= d0 && (e.d0 ?? d0) <= d1)
            .map((e) => ({
              at: e.at,
              message: e.message,
              from: e.d0 === undefined ? null : formatDay(e.d0),
              to: e.d1 === undefined ? null : formatDay(e.d1),
            })),
        }),
      );
      return makeResponse(body, 'application/json', version, false, true);
    });
  });

  // Öffentliche Liveness ohne Interna (Review W3); Details nur auf dem Status-Listener.
  app.get('/api/v1/health', async (req, reply) => {
    new Params(req.query).done();
    const { state } = health(deps);
    reply.header('Cache-Control', 'no-store');
    return reply.code(state === 'unhealthy' ? 503 : 200).send({
      status: state === 'healthy' ? 'ok' : state === 'degraded' ? 'degraded' : 'unavailable',
    });
  });
}
