import type { DbConfig } from '@orderflow/core';
import postgres from 'postgres';

export type Sql = postgres.Sql;

/** Einzelne Verbindung (max 1): Advisory-Locks und Transaktionen bleiben auf einer Sitzung. */
export function connect(cfg: DbConfig, database: string = cfg.database): Sql {
  return postgres({
    host: cfg.host,
    port: cfg.port,
    username: cfg.user,
    password: cfg.password,
    database,
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'orderflow-db-tools' },
  });
}
