import type { DbConfig } from '@orderflow/core';
import postgres from 'postgres';

export type Sql = postgres.Sql;

export interface ConnectOptions {
  /** application_name der Sitzung (sichtbar in pg_stat_activity). */
  applicationName?: string;
}

/**
 * Einzelne Verbindung (max 1): Advisory-Locks und Transaktionen bleiben auf einer Sitzung.
 * postgres@4 schließt Verbindungen sonst nach 30–60 min (`max_lifetime`) bzw. im Leerlauf
 * (`idle_timeout`) und baut sie neu auf; Session-Advisory-Locks gingen dabei unbemerkt verloren.
 * Beides ist deshalb abgeschaltet; ein Netzabbruch bleibt möglich und muss vom Lock-Halter vor
 * jeder Transaktion geprüft werden (siehe PostgresWriter.ensureLock).
 */
export function connect(
  cfg: DbConfig,
  database: string = cfg.database,
  opt: ConnectOptions = {},
): Sql {
  return postgres({
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database,
    max: 1,
    max_lifetime: null,
    idle_timeout: null,
    onnotice: () => {},
    connection: { application_name: opt.applicationName ?? 'orderflow-db-tools' },
  });
}
