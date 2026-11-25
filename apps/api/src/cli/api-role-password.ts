// Setzt das Passwort der nur lesenden API-Rolle (Migration 0009) aus OF_API_DB_PASSWORD, verbunden als
// Admin-Rolle (OF_DB_USER). Betriebswerkzeug wie die Migrationen, nicht Teil der API; gibt das
// Passwort nie aus.  Aufruf: npm run role:password -w @orderflow/api
import { parseConfig } from '@orderflow/core';
import { connect } from '@orderflow/db';
import { alterRolePasswordSql } from '../scram.ts';

async function main(): Promise<number> {
  const admin = parseConfig(process.env);
  const role = process.env.OF_API_DB_USER?.trim() || 'of_api';
  const pw = process.env.OF_API_DB_PASSWORD?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pw)) {
    console.error(
      'OF_API_DB_PASSWORD fehlt oder ist ungeeignet (16–128 Zeichen aus A–Z a–z 0–9 _ -)',
    );
    return 1;
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role) || role === admin.db.user) {
    console.error(`OF_API_DB_USER "${role}" ist ungültig oder die Admin-Rolle`);
    return 1;
  }
  const sql = connect(admin.db, admin.db.database, { applicationName: 'orderflow-api-role' });
  try {
    const [r] = await sql`SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = ${role}`;
    if (!r) {
      console.error(`Rolle ${role} fehlt – zuerst npm run db:migrate`);
      return 1;
    }
    if (r.rolsuper) {
      console.error(`Rolle ${role} ist Superuser – verweigert`);
      return 1;
    }
    // Nur den clientseitig berechneten SCRAM-Verifier senden, nie den Klartext (Review W4a).
    await sql.unsafe(alterRolePasswordSql(role, pw));
    console.log(`Passwort der Rolle ${role} gesetzt`);
    return 0;
  } finally {
    await sql.end();
  }
}

main().then(
  (c) => {
    process.exitCode = c;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  },
);
