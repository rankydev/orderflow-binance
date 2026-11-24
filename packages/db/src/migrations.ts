// Reine Teile des Migrationsmechanismus (ohne Datenbankzugriff, daher ohne DB testbar).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Migration {
  /** Vierstellige Versionsnummer, z. B. '0003'. */
  version: string;
  name: string;
  upSql: string;
  downSql: string;
  /** SHA256 (hex) der up-Datei; erkennt nachträgliche Änderungen angewendeter Migrationen. */
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Liest `NNNN_name.up.sql` + `NNNN_name.down.sql` aus einem Verzeichnis. */
export function loadMigrations(dir: string): Migration[] {
  const parts = new Map<string, { name: string; up?: string; down?: string }>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const m = FILE_RE.exec(file);
    if (!m)
      throw new Error(`Ungültiger Migrationsdateiname: ${file} (erwartet NNNN_name.up|down.sql)`);
    const [, version, name, dir_] = m as unknown as [string, string, string, 'up' | 'down'];
    const entry = parts.get(version) ?? { name };
    if (entry.name !== name)
      throw new Error(`Version ${version} hat zwei Namen: ${entry.name}, ${name}`);
    entry[dir_] = readFileSync(join(dir, file), 'utf8');
    parts.set(version, entry);
  }
  const versions = [...parts.keys()].sort();
  return versions.map((version, i) => {
    const e = parts.get(version)!;
    if (e.up === undefined || e.down === undefined) {
      throw new Error(`Migration ${version}_${e.name}: up- und down-Datei müssen beide existieren`);
    }
    if (Number(version) !== i + 1) {
      throw new Error(`Versionsnummern müssen lückenlos bei 0001 beginnen (gefunden: ${version})`);
    }
    return { version, name: e.name, upSql: e.up, downSql: e.down, checksum: sha256(e.up) };
  });
}

/** Prüft, dass die angewendeten Migrationen ein Präfix der Dateiliste sind und unverändert. */
export function assertConsistent(migrations: Migration[], applied: AppliedMigration[]): void {
  applied.forEach((a, i) => {
    const m = migrations[i];
    if (!m || m.version !== a.version) {
      throw new Error(
        `Angewendete Migration ${a.version}_${a.name} fehlt im Repo oder ist umsortiert`,
      );
    }
    if (m.checksum !== a.checksum) {
      throw new Error(
        `Migration ${a.version}_${a.name} wurde nach dem Anwenden geändert (Checksum-Abweichung). ` +
          'Angewendete Migrationen nie bearbeiten, sondern eine neue anlegen.',
      );
    }
  });
}

export function planUp(migrations: Migration[], applied: AppliedMigration[]): Migration[] {
  assertConsistent(migrations, applied);
  return migrations.slice(applied.length);
}

/** Die zuletzt angewendeten `steps` Migrationen, jüngste zuerst. */
export function planDown(
  migrations: Migration[],
  applied: AppliedMigration[],
  steps: number | 'all',
): Migration[] {
  assertConsistent(migrations, applied);
  const n = steps === 'all' ? applied.length : Math.min(steps, applied.length);
  return migrations.slice(applied.length - n, applied.length).reverse();
}
