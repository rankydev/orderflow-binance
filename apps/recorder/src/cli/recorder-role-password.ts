// Setzt das Passwort der Recorder-Rolle (Migration 0013) aus OF_RECORDER_DB_PASSWORD, verbunden als
// Admin-Rolle (OF_DB_USER). Gegenstück zu apps/api/src/cli/api-role-password.ts (gleiches Verfahren:
// Passwort liegt auf dem Server in einer 0600-Datei, gesendet wird nur der clientseitig berechnete
// SCRAM-Verifier, ausgegeben wird es nie). Aufruf: npm run role:password -w @orderflow/recorder
import { parseConfig } from '@orderflow/core';
// eine Implementierung des SCRAM-Verifiers für beide Rollen (packages/db)
import { alterRolePasswordSql, connect } from '@orderflow/db';

async function main(): Promise<number> {
  const admin = parseConfig(process.env);
  const role = process.env.OF_RECORDER_DB_USER?.trim() || 'of_recorder';
  const pw = process.env.OF_RECORDER_DB_PASSWORD?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(pw)) {
    console.error(
      'OF_RECORDER_DB_PASSWORD fehlt oder ist ungeeignet (16–128 Zeichen aus A–Z a–z 0–9 _ -)',
    );
    return 1;
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role) || role === admin.db.user) {
    console.error(`OF_RECORDER_DB_USER "${role}" ist ungültig oder die Admin-Rolle`);
    return 1;
  }
  const sql = connect(admin.db, admin.db.database, { applicationName: 'orderflow-recorder-role' });
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
