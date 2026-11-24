// Konfiguration der API aus Umgebungsvariablen. Die Datenbankwerte kommen aus parseConfig
// (@orderflow/core, dieselbe .env wie alle Werkzeuge); Benutzer und Passwort sind die der nur
// lesenden Rolle (OF_API_DB_USER/OF_API_DB_PASSWORD, Migration 0009), nie die Admin-Rolle.
import { ConfigError, parseConfig, type DbConfig, type Env } from '@orderflow/core';

export interface ApiConfig {
  db: DbConfig;
  /** Adresse, an die der HTTP-Server bindet (Standard nur Loopback; nginx davor, KONZEPT §2.4). */
  host: string;
  port: number;
  /**
   * Erlaubte Seiten-Ursprünge für CORS (TILE-FORMAT.md): Liste exakter Ursprünge, `*`, oder
   * `loopback` (Standard: jeder http-Ursprung auf 127.0.0.1/localhost/[::1], nur für die Entwicklung).
   */
  cors: string[] | '*' | 'loopback';
  /** Höchstzahl gleichzeitiger Datenbankabfragen (= Größe des Verbindungspools). */
  dbPool: number;
  /** Wartende Anfragen über dem Pool; darüber 503 + Retry-After. */
  maxQueue: number;
  /** Höchste Wartezeit in der Warteschlange (ms), danach 503. */
  queueTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  /** Wiederholungen nach Sperr-Zeitüberschreitung (lock_not_available), mit Backoff. */
  lockRetries: number;
  /** Speichergrenze des Antwort-Caches in Bytes (KONZEPT §5.4: ≤ 200 MB). */
  cacheBytes: number;
  /** Abfrageintervall der Tagesversionen (data_day) in ms. */
  pollMs: number;
  /** Höchstzahl geschätzter Quellzeilen je Anfrage (KONZEPT §1.4). */
  maxSourceRows: number;
  /** Harte Zeilengrenze je Profil-Antwort (KONZEPT §1.4); Kacheln folgen TILE-FORMAT.md (60 000). */
  maxCells: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const intIn = (
  problems: string[],
  env: Env,
  key: string,
  def: number,
  min: number,
  max: number,
): number => {
  const raw = env[key]?.trim();
  if (!raw) return def;
  const v = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(v) || v < min || v > max) {
    problems.push(`${key} muss eine ganze Zahl in ${min}…${max} sein: "${raw}"`);
    return def;
  }
  return v;
};

export function parseApiConfig(env: Env): ApiConfig {
  const problems: string[] = [];
  const user = env.OF_API_DB_USER?.trim() || 'of_api';
  const password = env.OF_API_DB_PASSWORD?.trim();
  if (!password)
    problems.push('OF_API_DB_PASSWORD fehlt (Passwort der Rolle of_api, siehe README)');
  let base;
  try {
    // Admin-Zugangsdaten nie übernehmen: Benutzer und Passwort der API-Rolle einsetzen.
    base = parseConfig({ ...env, OF_DB_USER: user, OF_DB_PASSWORD: password || 'unset' });
  } catch (e) {
    if (e instanceof ConfigError) problems.push(...e.problems);
    else throw e;
  }
  if (user === env.OF_DB_USER?.trim() && user !== 'of_api') {
    problems.push(`OF_API_DB_USER (${user}) darf nicht die Admin-Rolle OF_DB_USER sein`);
  }
  const host = env.OF_API_HOST?.trim() || '127.0.0.1';
  const port = intIn(problems, env, 'OF_API_PORT', 8780, 1, 65535);
  const corsRaw = env.OF_API_CORS_ORIGINS?.trim() || 'loopback';
  let cors: ApiConfig['cors'];
  if (corsRaw === '*' || corsRaw === 'loopback') cors = corsRaw;
  else {
    cors = corsRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const o of cors) {
      if (
        !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$|^https?:\/\/\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(o)
      )
        problems.push(`OF_API_CORS_ORIGINS: "${o}" ist kein Ursprung (schema://host[:port])`);
    }
  }
  const cfg: ApiConfig = {
    db: base?.db ?? { host: '', port: 0, user, password: '', database: '' },
    host,
    port,
    cors,
    dbPool: intIn(problems, env, 'OF_API_DB_POOL', 4, 1, 16),
    maxQueue: intIn(problems, env, 'OF_API_MAX_QUEUE', 64, 0, 10_000),
    queueTimeoutMs: intIn(problems, env, 'OF_API_QUEUE_TIMEOUT_MS', 10_000, 100, 120_000),
    statementTimeoutMs: intIn(problems, env, 'OF_API_STATEMENT_TIMEOUT_MS', 5_000, 100, 60_000),
    lockTimeoutMs: intIn(problems, env, 'OF_API_LOCK_TIMEOUT_MS', 1_000, 10, 30_000),
    lockRetries: intIn(problems, env, 'OF_API_LOCK_RETRIES', 3, 0, 10),
    cacheBytes: intIn(problems, env, 'OF_API_CACHE_MB', 200, 0, 4096) * 1024 * 1024,
    pollMs: intIn(problems, env, 'OF_API_POLL_MS', 1_000, 100, 600_000),
    maxSourceRows: intIn(problems, env, 'OF_API_MAX_SOURCE_ROWS', 1_500_000, 1, 1e9),
    maxCells: intIn(problems, env, 'OF_API_MAX_CELLS', 60_000, 1, 1e7),
    logLevel: base?.logLevel ?? 'info',
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}

/** Ursprung erlaubt? (CORS, nur GET ohne Credentials, TILE-FORMAT.md) */
export function corsAllowed(cfg: ApiConfig['cors'], origin: string): boolean {
  if (cfg === '*') return true;
  if (cfg === 'loopback')
    return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(origin);
  return cfg.includes(origin);
}
