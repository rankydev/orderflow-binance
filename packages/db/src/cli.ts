// Aufruf: node --env-file-if-exists=.env packages/db/src/cli.ts <up|down [n|all]|status|reset --yes>
import { isLocalHost, parseConfig } from '@orderflow/core';
import { connect } from './connection.ts';
import {
  dropAndCreateDatabase,
  ensureDatabase,
  migrateDown,
  migrateUp,
  migrationStatus,
} from './migrate.ts';

const log = (m: string) => console.log(m);

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  const cfg = parseConfig(process.env);

  if (cmd === 'reset') {
    if (arg !== '--yes') {
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
    console.error('Verwendung: cli.ts <up | down [n|all] | status | reset --yes>');
    return 1;
  }

  const sql = connect(cfg.db);
  try {
    if (cmd === 'reset' || cmd === 'up') {
      await migrateUp(sql, undefined, log);
    } else if (cmd === 'down') {
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
