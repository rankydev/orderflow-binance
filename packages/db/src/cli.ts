// Aufruf: node --env-file-if-exists=.env packages/db/src/cli.ts
//   <up | status | reset --yes | down [n|all] --yes [--destroy-data]>
// reset und down verweigern eine Datenbank mit Produktionsmarker (guard.ts); down verlangt immer
// --yes und bei vorhandenen Tagesdaten (data_day) zusätzlich --destroy-data.
import { isLocalHost, parseConfig } from '@orderflow/core';
import { connect } from './connection.ts';
import { isProductionDatabase, PRODUCTION_MARKER } from './guard.ts';
import {
  dropAndCreateDatabase,
  ensureDatabase,
  migrateDown,
  migrateUp,
  migrationStatus,
} from './migrate.ts';

const log = (m: string) => console.log(m);

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const arg = rest.find((a) => !a.startsWith('--'));
  const cfg = parseConfig(process.env);

  if (cmd === 'reset') {
    if (!flags.has('--yes')) {
      console.error(
        'reset löscht die Datenbank "' +
          cfg.db.database +
          '" komplett. Zum Bestätigen: reset --yes',
      );
      return 1;
    }
    await dropAndCreateDatabase(cfg.db);
    log(`Datenbank ${cfg.db.database} neu angelegt`);
  } else if (cmd === 'up' || cmd === 'down' || cmd === 'status') {
    // Lokal legt das Werkzeug eine fehlende Datenbank an; auf fremden Hosts nie.
    if (isLocalHost(cfg.db.host)) await ensureDatabase(cfg.db);
  } else {
    console.error(
      'Verwendung: cli.ts <up | status | reset --yes | down [n|all] --yes [--destroy-data]>',
    );
    return 1;
  }

  const sql = connect(cfg.db);
  try {
    if (cmd === 'reset' || cmd === 'up') {
      await migrateUp(sql, undefined, log);
    } else if (cmd === 'down') {
      if (!flags.has('--yes')) {
        console.error('down entfernt Tabellen/Spalten. Zum Bestätigen: down [n|all] --yes');
        return 1;
      }
      if (await isProductionDatabase(sql, cfg.db.database)) {
        console.error(
          `down verweigert: Datenbank "${cfg.db.database}" trägt den Produktionsmarker (${PRODUCTION_MARKER})`,
        );
        return 1;
      }
      const [dd] = await sql`SELECT to_regclass('public.data_day') IS NOT NULL AS t`;
      if (dd!.t && !flags.has('--destroy-data')) {
        const [n] = await sql`SELECT EXISTS (SELECT 1 FROM data_day) AS any`;
        if (n!.any) {
          console.error(
            'down verweigert: data_day enthält Tage. Nur mit --destroy-data (Daten gehen verloren).',
          );
          return 1;
        }
      }
      const steps = arg === 'all' ? 'all' : arg === undefined ? 1 : Number(arg);
      if (steps !== 'all' && (!Number.isInteger(steps) || steps < 1)) {
        console.error('down erwartet eine positive Zahl oder "all"');
        return 1;
      }
      await migrateDown(sql, steps, undefined, log);
    } else {
      for (const s of await migrationStatus(sql)) {
        log(`${s.applied ? 'angewendet ' : 'ausstehend '} ${s.version}_${s.name}`);
      }
    }
    return 0;
  } finally {
    await sql.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
