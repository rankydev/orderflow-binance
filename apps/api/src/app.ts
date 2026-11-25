// Fastify-Anwendung: nur lesende Endpunkte, CORS (TILE-FORMAT.md), Abbruch bei Client-Abbruch,
// einheitliche Fehler ({ error } + Status), strukturierte Logs ohne Secrets.
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { corsAllowed } from './config.ts';
import { newCtx, type Deps } from './context.ts';
import { HttpError } from './errors.ts';
import { registerProfileRoutes } from './routes/profile.ts';
import { healthDetail, registerStatusRoutes } from './routes/status.ts';
import { registerTileRoutes } from './routes/tiles.ts';

export interface AppOptions {
  /** false: kein Logger (Tests); sonst Pino-Optionen (Level). */
  logger?: false | { level: string };
}

export function buildApp(deps: Deps, opt: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger:
      opt.logger === false
        ? false
        : {
            level: opt.logger?.level ?? deps.cfg.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie'],
          },
    // eigene Zeile je Anfrage in onResponse (mit Cache/Quelle/DB-Zeit) statt der Standard-Logs
    logController: new LogController({ disableRequestLogging: true }),
    // Keine Rohdaten über den Body: die API nimmt keine Körper an
    bodyLimit: 1024,
    return503OnClosing: true,
    forceCloseConnections: 'idle',
    // Review W2: Fastify setzt sonst connectionTimeout/requestTimeout = 0 (aus)
    connectionTimeout: deps.cfg.connectionTimeoutMs,
    requestTimeout: deps.cfg.requestTimeoutMs,
    keepAliveTimeout: deps.cfg.keepAliveTimeoutMs,
    maxRequestsPerSocket: deps.cfg.maxRequestsPerSocket,
    http: {
      headersTimeout: Math.min(20_000, deps.cfg.requestTimeoutMs),
      // Node prüft request-/headersTimeout nur in diesem Takt (Standard 30 s)
      connectionsCheckingInterval: Math.min(1_000, deps.cfg.requestTimeoutMs),
    },
    routerOptions: { ignoreTrailingSlash: false, maxParamLength: 200 },
  });

  app.server.maxConnections = deps.cfg.maxConnections;

  app.decorateRequest('ctx', null as never);
  app.addHook('onRequest', async (req, reply) => {
    req.ctx = newCtx();
    // Client-Abbruch: Antwort nicht fertig, Verbindung zu → laufende Abfrage abbrechen (§5.4)
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) req.ctx.ac.abort();
    });
    const origin = req.headers.origin;
    if (typeof origin === 'string' && corsAllowed(deps.cfg.cors, origin)) {
      reply.header('Access-Control-Allow-Origin', deps.cfg.cors === '*' ? '*' : origin);
      reply.header(
        'Access-Control-Expose-Headers',
        deps.cfg.diagHeaders
          ? 'ETag, Retry-After, X-Cache, X-Source, X-Rows-Estimate'
          : 'ETag, Retry-After, X-Cache',
      );
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const c = req.ctx;
    reply.header('X-Content-Type-Options', 'nosniff');
    if (c?.cache) reply.header('X-Cache', c.cache);
    // Tabellennamen, Zeilenschätzung und DB-Zeit nur auf Wunsch (OF_API_DIAG_HEADERS)
    if (deps.cfg.diagHeaders) {
      if (c?.src) reply.header('X-Source', c.src);
      if (c?.rowsEstimate !== null && c?.rowsEstimate !== undefined)
        reply.header('X-Rows-Estimate', String(c.rowsEstimate));
      if (c?.db) reply.header('Server-Timing', `db;dur=${c.db.dbMs.toFixed(1)}`);
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const c = req.ctx;
    req.log.info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime * 10) / 10,
        bytes: c?.bytes ?? undefined,
        raw: c?.rawBytes ?? undefined,
        cache: c?.cache ?? undefined,
        src: c?.src ?? undefined,
        rowsEst: c?.rowsEstimate ?? undefined,
        dbMs: c?.db ? Math.round(c.db.dbMs * 10) / 10 : undefined,
        attempts: c?.db?.attempts,
        aborted: c?.ac.signal.aborted || undefined,
      },
      'request',
    );
  });

  app.options('/api/v1/*', async (req, reply) => {
    reply
      .header('Access-Control-Allow-Methods', 'GET, HEAD')
      .header('Access-Control-Max-Age', '86400')
      .code(204)
      .send();
  });

  app.setNotFoundHandler(async (req, reply) =>
    reply
      .code(404)
      .header('Cache-Control', 'no-store')
      .send({ error: `unbekannter Endpunkt ${req.url.split('?')[0]}` }),
  );

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.retryAfter !== null) reply.header('Retry-After', String(err.retryAfter));
      reply.header('Cache-Control', 'no-store');
      if (err.status >= 500)
        req.log.warn({ err: err.message, status: err.status }, 'request failed');
      return reply.code(err.status).send({ error: err.message, ...err.extra });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .header('Cache-Control', 'no-store')
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
    req.log.error({ err }, 'internal error');
    return reply.code(500).header('Cache-Control', 'no-store').send({ error: 'interner Fehler' });
  });

  registerTileRoutes(app, deps);
  registerProfileRoutes(app, deps);
  registerStatusRoutes(app, deps);
  return app;
}

/**
 * Getrennter Status-Listener (Review W3): nur 127.0.0.1, ein Pfad /health mit Interna (Katalogfehler,
 * Speicher, Cache, Limiter). Der öffentliche Port kennt nur die knappe Liveness-Antwort.
 */
export function buildAdminApp(deps: Deps): FastifyInstance {
  const startedAt = Date.now();
  const admin = Fastify({ logger: false, connectionTimeout: 10_000, requestTimeout: 10_000 });
  admin.get('/health', async (_req, reply) => healthDetail(deps, startedAt, reply));
  return admin;
}
