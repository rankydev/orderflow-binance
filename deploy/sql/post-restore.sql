-- Nach pg_restore (deploy/transfer-db.sh): Timescale aus dem Restore-Modus holen und das
-- Datenbankrecht wiederherstellen, das pg_dump ohne --create nicht sichert (GRANT CONNECT aus
-- Migration 0009; die übrigen Datenbankrechte der Quelle, z. B. CONNECT für of_recorder ab 0013,
-- überträgt roles-source.sql aus export-roles.sql). Statistiken baut danach `vacuumdb --analyze-only` (PG 17 überträgt keine).
\set ON_ERROR_STOP on
SELECT timescaledb_post_restore();
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO of_api', current_database());
END
$$;
