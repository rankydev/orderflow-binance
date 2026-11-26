// Testrolle als Spiegel von of_api (Rechte und Rolleneinstellungen aus den Migrationen), gemeinsam für
// die DB-Integrationstests der API. Rollen gelten clusterweit: Tests ändern nie das Passwort von of_api.
import { alterRolePasswordSql, type Sql } from '@orderflow/db';

/** Legt die Testrolle als Spiegel von of_api in der Testdatenbank an (Rechte + Rolleneinstellungen). */
export async function mirrorApiRole(sql: Sql, role: string, password: string): Promise<void> {
  await sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
      CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    END IF; END $$`);
  // nur der SCRAM-Verifier geht an den Server (W4a); jede API-Verbindung unten beweist, dass er gilt
  await sql.unsafe(alterRolePasswordSql(role, password));
  const [cfg] = await sql<{ rolconfig: string[] | null }[]>`
    SELECT rolconfig FROM pg_roles WHERE rolname = 'of_api'`;
  await sql.unsafe(`ALTER ROLE ${role} RESET ALL`);
  for (const kv of cfg!.rolconfig ?? []) {
    const m = /^([a-z_]+)=([A-Za-z0-9_.]+)$/.exec(kv);
    if (!m) throw new Error(`unerwartete Rolleneinstellung ${kv}`);
    await sql.unsafe(`ALTER ROLE ${role} SET ${m[1]} = '${m[2]}'`);
  }
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  const grants = await sql<{ t: string }[]>`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')
       AND has_table_privilege('of_api', c.oid, 'SELECT')`;
  for (const { t } of grants) await sql.unsafe(`GRANT SELECT ON "${t}" TO ${role}`);
}
