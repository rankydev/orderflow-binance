// GET /api/v1/quality (KONZEPT §4.9; Vertrag in docs/PROFILE-API.md, Abschnitt Qualität) und
// GET /api/v1/health (öffentlich nur {status}); die ausführliche Antwort liefert der getrennte
// Status-Listener auf 127.0.0.1 (KONZEPT §2.5; Recorder-, Platten- und Uhrprüfung folgen mit P2).
import { formatDay } from '@orderflow/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { guardedRead, requireSymbol, type Deps } from '../context.ts';
import { badRequest } from '../errors.ts';
import { acceptsGzip, etagOfBody, makeResponse, send } from '../http.ts';
import { DAY_MS, MAX_TIME_MS, Params, SYMBOL_RE } from '../params.ts';
import { coveredDays } from '../plan.ts';
import { queryIssues, queryQualityDays } from '../queries.ts';

export const QUALITY_SCHEMA = 1;
export const MAX_QUALITY_DAYS = 1_100;
export const MAX_ISSUES = 20_000;

/** Gründe, warum die API nicht gesund ist (leer = gesund). */
function healthReasons(deps: Deps): string[] {
  const reasons: string[] = [];
  const cat = deps.catalog;
  const age = cat.lastRefresh > 0 ? Date.now() - cat.lastRefresh : null;
  if (!cat.ready) reasons.push('Katalog noch nicht geladen');
  else if (age! > Math.max(30_000, deps.cfg.pollMs * 10))
    reasons.push(`Katalog seit ${Math.round(age! / 1000)} s nicht aktualisiert`);
  if (cat.lastError) reasons.push(`Datenbank: ${cat.lastError}`);
  return reasons;
}

/** Ausführliche Health-Antwort – nur auf dem Loopback-Status-Listener (buildAdminApp). */
export function healthDetail(deps: Deps, startedAt: number, reply: FastifyReply): FastifyReply {
  const reasons = healthReasons(deps);
  const cat = deps.catalog;
  const mem = process.memoryUsage();
  reply.header('Cache-Control', 'no-store');
  return reply.code(reasons.length === 0 ? 200 : 503).send({
    status: reasons.length === 0 ? 'healthy' : 'unhealthy',
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
    p.done();
    const s = requireSymbol(deps, symName);
    if (to <= from) throw badRequest('to muss größer als from sein');
    const [d0, d1] = coveredDays(from, to);
    if (d1 - d0 + 1 > MAX_QUALITY_DAYS) throw badRequest(`höchstens ${MAX_QUALITY_DAYS} Tage`);
    const { days, issues } = await guardedRead(deps, req.ctx, async (tx) => ({
      days: await queryQualityDays(tx, s.symId, d0, d1),
      issues: await queryIssues(tx, s.symId, d0 * DAY_MS, (d1 + 1) * DAY_MS, withShift, MAX_ISSUES),
    }));
    const truncated = issues.length > MAX_ISSUES;
    const body = Buffer.from(
      JSON.stringify({
        schema: QUALITY_SCHEMA,
        kind: 'quality',
        sym: s.name,
        from: d0 * DAY_MS,
        to: (d1 + 1) * DAY_MS,
        days: days.map((d) => ({ ...d, day: formatDay(d.day), from: d.day * DAY_MS })),
        issues: truncated ? issues.slice(0, MAX_ISSUES) : issues,
        issuesIncludeShift: withShift,
        issuesTruncated: truncated,
      }),
    );
    // Qualitätsangaben können sich ohne neue Datenversion ändern (z. B. deep_check) → nie immutable.
    const r = await makeResponse(
      body,
      'application/json',
      etagOfBody(body),
      false,
      acceptsGzip(req),
    );
    return send(req, reply, r);
  });

  // Öffentliche Liveness ohne Interna (Review W3); Details nur auf dem Status-Listener.
  app.get('/api/v1/health', async (req, reply) => {
    new Params(req.query).done();
    const ok = healthReasons(deps).length === 0;
    reply.header('Cache-Control', 'no-store');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'unavailable' });
  });
}
