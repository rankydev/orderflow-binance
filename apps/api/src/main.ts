// Einstiegspunkt der API (Daemon, KONZEPT §2.1): nur lesend, bindet standardmäßig an 127.0.0.1.
//   node --env-file-if-exists=.env apps/api/src/main.ts      (bzw. npm start -w @orderflow/api)
// Beenden mit SIGINT/SIGTERM: keine neuen Verbindungen, laufende Anfragen fertig, Pools schließen.
import { ConfigError } from '@orderflow/core';
import { buildAdminApp, buildApp } from './app.ts';
import type { Deps } from './context.ts';
import { ResponseCache } from './cache.ts';
import { Catalog } from './catalog.ts';
import { parseApiConfig, type ApiConfig } from './config.ts';
import { createPool } from './db.ts';
import { Limiter } from './limiter.ts';

export interface RunningApi {
  url: string;
  /** Status-Listener (nur 127.0.0.1) oder null, wenn OF_API_ADMIN_PORT = 0. */
  adminUrl: string | null;
  deps: Deps;
  close: () => Promise<void>;
}

/** Startet die API (auch für Tests und den Benchmark); wartet, bis der Katalog geladen ist. */
export async function startApi(
  cfg: ApiConfig,
  opt: { logger?: false | { level: string } } = {},
): Promise<RunningApi> {
  const sql = createPool(cfg);
  // eigener Ein-Verbindungs-Pool für den Katalog: Anfragen-Bursts blockieren ihn nicht und umgekehrt
  const catSql = createPool({ ...cfg, dbPool: 1 }, 'orderflow-api-catalog');
  const cache = new ResponseCache(cfg.cacheBytes);
  const limiter = new Limiter(cfg.dbPool, cfg.maxQueue, cfg.queueTimeoutMs);
  let app: ReturnType<typeof buildApp> | null = null;
  const catalog = new Catalog(catSql, {
    pollMs: cfg.pollMs,
    lockRetries: cfg.lockRetries,
    maxSourceRows: cfg.maxSourceRows,
    log: (level, msg, obj) => app?.log[level](obj ?? {}, msg),
  });
  const deps: Deps = { cfg, sql, catalog, cache, limiter };
  app = buildApp(deps, opt);
  catalog.on('dayChanged', (ev) => app?.log.debug(ev, 'dayChanged'));
  await catalog.start();
  if (!catalog.ready) app.log.warn({ err: catalog.lastError }, 'Katalog beim Start nicht geladen');
  else
    app.log.info(
      {
        symbols: catalog.symbols().map((s) => ({
          name: s.name,
          days: s.days.size,
          dataFrom: new Date(s.dataFrom).toISOString(),
          dataTo: new Date(s.dataTo).toISOString(),
          tileConfigVersion: s.tileConfigVersion,
        })),
      },
      'Katalog geladen',
    );
  const shutdown = async () => {
    await app.close();
    await admin?.close();
    await catalog.stop();
    await Promise.all([sql.end({ timeout: 5 }), catSql.end({ timeout: 5 })]);
  };
  // Status-Listener immer nur auf Loopback, unabhängig von OF_API_HOST (Review W3)
  const admin = cfg.adminPort > 0 ? buildAdminApp(deps) : null;
  let url: string;
  let adminUrl: string | null = null;
  try {
    url = await app.listen({ host: cfg.host, port: cfg.port });
    if (admin) adminUrl = await admin.listen({ host: '127.0.0.1', port: cfg.adminPort });
  } catch (e) {
    // z. B. Port belegt: Pools schließen, sonst bliebe der Prozess ohne Listener hängen
    await shutdown().catch(() => {});
    throw e;
  }
  let closing: Promise<void> | null = null;
  return {
    url,
    adminUrl,
    deps,
    close: () => (closing ??= shutdown()),
  };
}

async function main(): Promise<number> {
  let cfg: ApiConfig;
  try {
    cfg = parseApiConfig(process.env);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    return 1;
  }
  const api = await startApi(cfg);
  const stop = (sig: string) => {
    console.error(JSON.stringify({ level: 30, msg: `${sig}: beende` }));
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    api.close().then(
      () => process.exit(0),
      (e: unknown) => {
        console.error(e);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    },
  );
}
