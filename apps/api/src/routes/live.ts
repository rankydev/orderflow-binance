// GET /api/v1/live?sym=… – Live-Strom (SSE, KONZEPT §5.7, Format @orderflow/core wire.ts). Ohne
// Datenbank: der LiveHub hält eine Verbindung zum Recorder und verteilt. Die Antwort wird gekapert
// (reply.hijack), damit Fastify sie nicht abschließt; nginx puffert dank X-Accel-Buffering nicht.
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { Params, SYMBOL_RE } from '../params.ts';

export function registerLiveRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/v1/live', async (req, reply) => {
    const p = new Params(req.query);
    const sym = p.str('sym', SYMBOL_RE);
    p.done();
    const hub = deps.live;
    if (!hub) throw new HttpError(503, 'Live-Daten nicht eingerichtet', {}, 60);
    if (!deps.catalog.symbol(sym) && !hub.knows(sym)) throw notFound(`unbekanntes Symbol ${sym}`);
    if (hub.full) throw new HttpError(503, 'zu viele Live-Verbindungen', {}, 10);
    if (req.method === 'HEAD')
      return reply.code(200).header('Cache-Control', 'no-store').type('text/event-stream').send();
    reply.hijack();
    hub.attach(sym, reply.raw, reply.getHeaders());
    return reply;
  });
}
