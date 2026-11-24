// Konfiguration aus Umgebungsvariablen (KONZEPT §2.4: Secrets nie im Repo, nur aus .env/EnvironmentFile).
// Rein: bekommt das env-Objekt übergeben und liest weder Dateien noch process.env.

export interface DbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface AppConfig {
  db: DbConfig;
  /** Wurzel für Rohdaten/Spool (relativ zum Arbeitsverzeichnis oder absolut). */
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Ungültige Konfiguration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export type Env = Record<string, string | undefined>;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export function parseConfig(env: Env): AppConfig {
  const problems: string[] = [];
  const str = (key: string, fallback?: string): string => {
    const v = env[key]?.trim();
    if (v) return v;
    if (fallback !== undefined) return fallback;
    problems.push(`${key} fehlt (siehe .env.example)`);
    return '';
  };

  const host = str('OF_DB_HOST', '127.0.0.1');
  const portRaw = str('OF_DB_PORT', '54320');
  const user = str('OF_DB_USER', 'of_admin');
  const password = str('OF_DB_PASSWORD');
  const database = str('OF_DB_NAME', 'orderflow');
  const dataDir = str('OF_DATA_DIR', 'data');
  const logLevel = str('OF_LOG_LEVEL', 'info');

  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`OF_DB_PORT ist keine gültige Portnummer: "${portRaw}"`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) {
    problems.push(`OF_DB_NAME ist kein einfacher Bezeichner: "${database}"`);
  }
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    problems.push(`OF_LOG_LEVEL muss eines von ${LOG_LEVELS.join('|')} sein: "${logLevel}"`);
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    db: { host, port, user, password, database },
    dataDir,
    logLevel: logLevel as AppConfig['logLevel'],
  };
}

/** Nur Loopback-Hosts gelten als „lokal" (Schutz für destruktive Befehle wie db:reset). */
export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}
