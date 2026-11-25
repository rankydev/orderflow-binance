// Schutz destruktiver Datenbankbefehle (db:reset, down): eine Produktionsdatenbank trägt den
// Kommentar „orderflow:production" (COMMENT ON DATABASE). Ein Kommentar auf Datenbankebene reist
// nicht mit pg_dump/pg_restore in eine bestehende Datenbank (nur mit --create) – gesetzt wird er
// daher vom Server selbst (Installation und nach jedem Restore), nie auf dem Mac. Der Loopback-
// Check allein genügt nicht: ein SSH-Tunnel zum VPS sieht wie 127.0.0.1 aus.
import type { Sql } from './connection.ts';

export const PRODUCTION_MARKER = 'orderflow:production';

/** Trägt die Datenbank `database` den Produktionsmarker? (Abfrage aus beliebiger DB des Clusters) */
export async function isProductionDatabase(sql: Sql, database: string): Promise<boolean> {
  const [r] = await sql`
    SELECT coalesce(shobj_description(oid, 'pg_database'), '') AS c
      FROM pg_database WHERE datname = ${database}`;
  return r !== undefined && (r.c as string).includes(PRODUCTION_MARKER);
}
