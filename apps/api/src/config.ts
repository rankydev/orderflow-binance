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
  /**
   * statement_timeout des Katalog-Pools (ms, Standard 30 000): die Statistik-Abfragen lesen bis zu einem
   * Jahr bar_1m je Symbol; auf einem kalten VPS darf das länger dauern als eine Anfrage (Standard 5 s).
   */
  catalogStatementTimeoutMs: number;
  lockTimeoutMs: number;
  /** Wiederholungen nach Sperr-Zeitüberschreitung (lock_not_available), mit Backoff. */
  lockRetries: number;
  /** Speichergrenze des Antwort-Caches in Bytes (KONZEPT §5.4: ≤ 200 MB). */
  cacheBytes: number;
  /** Abfrageintervall der Tagesversionen (data_day) in ms. */
  pollMs: number;
  /**
   * Ereignis-Feed des Recorders (SSE, `event: minute` je festgeschriebener Minute), z. B.
   * http://recorder:7701/events; jedes Ereignis stößt sofort eine Katalog-Aktualisierung an, statt bis
   * zur nächsten Abfrage (pollMs) zu warten. null = aus (die Abfrage allein genügt, nur langsamer).
   */
  recorderEventsUrl: string | null;
  /**
   * Live-Strom des Recorders (SSE GET /live, KONZEPT §5.7), z. B. http://recorder:7701/live; die API hält
   * genau eine Verbindung und verteilt an GET /api/v1/live. null = aus (/api/v1/live antwortet 503).
   */
  recorderLiveUrl: string | null;
  /** Höchstzahl gleichzeitiger Live-Clients (GET /api/v1/live). */
  liveMaxClients: number;
  /** Höchstzahl geschätzter Quellzeilen je Anfrage (KONZEPT §1.4). */
  maxSourceRows: number;
  /**
   * Höchstzahl geschätzter Quellzeilen je Footprint-Kachel (Standard 300 000): engere Grenze als für
   * Profile, damit eine angebotene Kachel auch auf dem 2-vCPU-VPS im Budget bleibt (TILE-FORMAT.md).
   */
  maxTileSourceRows: number;
  /** Harte Zeilengrenze je Profil-Antwort (KONZEPT §1.4); Kacheln folgen TILE-FORMAT.md (60 000). */
  maxCells: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Höchstalter nicht finaler Antworten im Server-Cache (ms); 0 = nicht cachen (Review W1). */
  nonFinalTtlMs: number;
  /** Socket-Inaktivität bis zum Schließen (ms) – gegen Slow-Loris und Leerlauf-Sockets (W2). */
  connectionTimeoutMs: number;
  /** Höchstdauer einer Anfrage inkl. Kopfzeilen (ms) (W2). */
  requestTimeoutMs: number;
  /**
   * Keep-Alive im Leerlauf (ms). Über dem `keepalive_timeout` des nginx-upstream-Blocks (Standard
   * 60 s), damit nginx eine Verbindung nie wiederverwendet, die die API gerade schließt (sonst 502).
   */
  keepAliveTimeoutMs: number;
  /** Anfragen je Socket (0 = unbegrenzt). */
  maxRequestsPerSocket: number;
  /** Höchstzahl offener Verbindungen am öffentlichen Port. */
  maxConnections: number;
  /**
   * Port des getrennten Status-Listeners (nur 127.0.0.1) mit der ausführlichen Health-Antwort (W3);
   * 0 = aus. Der öffentliche Port liefert unter /api/v1/health nur {status}.
   */
  adminPort: number;
  /** Diagnose-Header X-Source, X-Rows-Estimate, Server-Timing (Standard aus). */
  diagHeaders: boolean;
  /**
   * Schlägt die Katalog-Aktualisierung länger als diese Zeit (ms) fehl, antworten die Datenendpunkte
   * mit 503 statt mit 304/Cache-Treffern auf einem womöglich veralteten Versionsstand.
   */
  staleAfterMs: number;
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
    catalogStatementTimeoutMs: intIn(
      problems,
      env,
      'OF_API_CATALOG_STATEMENT_TIMEOUT_MS',
      30_000,
      1_000,
      600_000,
    ),
    lockTimeoutMs: intIn(problems, env, 'OF_API_LOCK_TIMEOUT_MS', 1_000, 10, 30_000),
    lockRetries: intIn(problems, env, 'OF_API_LOCK_RETRIES', 3, 0, 10),
    cacheBytes: intIn(problems, env, 'OF_API_CACHE_MB', 200, 0, 4096) * 1024 * 1024,
    pollMs: intIn(problems, env, 'OF_API_POLL_MS', 1_000, 100, 600_000),
    recorderEventsUrl: eventsUrl(problems, env.OF_API_RECORDER_EVENTS_URL),
    recorderLiveUrl: eventsUrl(problems, env.OF_API_RECORDER_LIVE_URL, 'OF_API_RECORDER_LIVE_URL'),
    liveMaxClients: intIn(problems, env, 'OF_API_LIVE_MAX', 150, 1, 10_000),
    maxSourceRows: intIn(problems, env, 'OF_API_MAX_SOURCE_ROWS', 1_500_000, 1, 1e9),
    maxTileSourceRows: intIn(problems, env, 'OF_API_MAX_TILE_SOURCE_ROWS', 300_000, 1, 1e9),
    maxCells: intIn(problems, env, 'OF_API_MAX_CELLS', 60_000, 1, 1e7),
    logLevel: base?.logLevel ?? 'info',
    nonFinalTtlMs: intIn(problems, env, 'OF_API_NONFINAL_TTL_MS', 10_000, 0, 600_000),
    connectionTimeoutMs: intIn(problems, env, 'OF_API_CONNECTION_TIMEOUT_MS', 30_000, 100, 600_000),
    requestTimeoutMs: intIn(problems, env, 'OF_API_REQUEST_TIMEOUT_MS', 30_000, 100, 600_000),
    keepAliveTimeoutMs: intIn(problems, env, 'OF_API_KEEPALIVE_TIMEOUT_MS', 65_000, 100, 600_000),
    maxRequestsPerSocket: intIn(problems, env, 'OF_API_MAX_REQUESTS_PER_SOCKET', 1_000, 0, 1e6),
    maxConnections: intIn(problems, env, 'OF_API_MAX_CONNECTIONS', 1_024, 1, 1e6),
    adminPort: intIn(problems, env, 'OF_API_ADMIN_PORT', 8781, 0, 65535),
    diagHeaders: /^(1|true|on)$/i.test(env.OF_API_DIAG_HEADERS?.trim() ?? ''),
    staleAfterMs: intIn(problems, env, 'OF_API_STALE_AFTER_MS', 30_000, 1_000, 3_600_000),
  };
  // Live-Clients halten je eine Verbindung dauerhaft: 64 bleiben für Kacheln/Bars/Profile frei
  if (cfg.liveMaxClients > cfg.maxConnections - 64)
    problems.push(
      `OF_API_LIVE_MAX (${cfg.liveMaxClients}) muss ≤ OF_API_MAX_CONNECTIONS − 64 (${cfg.maxConnections - 64}) sein`,
    );
  if (cfg.adminPort !== 0 && cfg.adminPort === cfg.port)
    problems.push('OF_API_ADMIN_PORT muss sich von OF_API_PORT unterscheiden');
  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}

function eventsUrl(
  problems: string[],
  raw: string | undefined,
  key = 'OF_API_RECORDER_EVENTS_URL',
): string | null {
  const v = raw?.trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    problems.push(`${key}: "${v}" ist keine URL`);
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    problems.push(`${key}: nur http(s)`);
    return null;
  }
  if (u.username || u.password) {
    problems.push(`${key}: ohne Zugangsdaten`);
    return null;
  }
  return u.href;
}

/** Ursprung erlaubt? (CORS, nur GET ohne Credentials, TILE-FORMAT.md) */
export function corsAllowed(cfg: ApiConfig['cors'], origin: string): boolean {
  if (cfg === '*') return true;
  if (cfg === 'loopback')
    return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(origin);
  return cfg.includes(origin);
}
