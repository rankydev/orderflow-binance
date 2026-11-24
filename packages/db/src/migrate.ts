import { isLocalHost, type DbConfig } from '@orderflow/core';
import { connect, type Sql } from './connection.ts';
import {
  loadMigrations,
  planDown,
  planUp,
  type AppliedMigration,
  type Migration,
} from './migrations.ts';

export const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url).pathname;

// Beliebige feste Zahl: serialisiert gleichzeitige Migrationsläufe auf derselben Datenbank.
const LOCK_KEY = 7_042_024;

export type Logger = (message: string) => void;

async function ensureTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
}

async function listApplied(sql: Sql): Promise<AppliedMigration[]> {
  return sql<AppliedMigration[]>`
    SELECT version, name, checksum FROM schema_migrations ORDER BY version`;
}

async function withLock<T>(sql: Sql, fn: () => Promise<T>): Promise<T> {
  await sql`SELECT pg_advisory_lock(${LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${LOCK_KEY})`;
  }
}

/** Wendet alle ausstehenden Migrationen an (je Migration eine Transaktion). Idempotent. */
export async function migrateUp(
  sql: Sql,
  migrations: Migration[] = loadMigrations(MIGRATIONS_DIR),
  log: Logger = () => {},
): Promise<string[]> {
  return withLock(sql, async () => {
    await ensureTable(sql);
    const pending = planUp(migrations, await listApplied(sql));
    for (const m of pending) {
      await sql.begin(async (tx) => {
        await tx.unsafe(m.upSql);
        await tx`INSERT INTO schema_migrations (version, name, checksum)
                 VALUES (${m.version}, ${m.name}, ${m.checksum})`;
      });
      log(`up   ${m.version}_${m.name}`);
    }
    if (pending.length === 0) log('nichts zu tun (Schema aktuell)');
    return pending.map((m) => `${m.version}_${m.name}`);
  });
}

/** Rollt die letzten `steps` Migrationen zurück (jüngste zuerst). */
export async function migrateDown(
  sql: Sql,
  steps: number | 'all' = 1,
  migrations: Migration[] = loadMigrations(MIGRATIONS_DIR),
  log: Logger = () => {},
): Promise<string[]> {
  return withLock(sql, async () => {
    await ensureTable(sql);
    const todo = planDown(migrations, await listApplied(sql), steps);
    for (const m of todo) {
      await sql.begin(async (tx) => {
        await tx.unsafe(m.downSql);
        await tx`DELETE FROM schema_migrations WHERE version = ${m.version}`;
      });
      log(`down ${m.version}_${m.name}`);
    }
    if (todo.length === 0) log('nichts zurückzurollen');
    return todo.map((m) => `${m.version}_${m.name}`);
  });
}

export async function migrationStatus(
  sql: Sql,
  migrations: Migration[] = loadMigrations(MIGRATIONS_DIR),
): Promise<{ version: string; name: string; applied: boolean }[]> {
  await ensureTable(sql);
  const applied = new Set((await listApplied(sql)).map((a) => a.version));
  return migrations.map((m) => ({
    version: m.version,
    name: m.name,
    applied: applied.has(m.version),
  }));
}

/** Legt die Datenbank an, falls sie fehlt (über die Wartungsdatenbank `postgres`). */
export async function ensureDatabase(cfg: DbConfig): Promise<void> {
  const admin = connect(cfg, 'postgres');
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${cfg.database}`;
    if (rows.length === 0) await admin`CREATE DATABASE ${admin(cfg.database)}`;
  } finally {
    await admin.end();
  }
}

/** Löscht die Datenbank vollständig und legt sie leer neu an. Nur für Loopback-Hosts. */
export async function dropAndCreateDatabase(cfg: DbConfig): Promise<void> {
  if (!isLocalHost(cfg.host)) {
    throw new Error(
      `reset verweigert: Host "${cfg.host}" ist nicht lokal (nur 127.0.0.1/localhost)`,
    );
  }
  const admin = connect(cfg, 'postgres');
  try {
    await admin`DROP DATABASE IF EXISTS ${admin(cfg.database)} WITH (FORCE)`;
    await admin`CREATE DATABASE ${admin(cfg.database)}`;
  } finally {
    await admin.end();
  }
}
