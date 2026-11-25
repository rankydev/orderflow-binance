-- Nach pg_restore (deploy/transfer-db.sh): Timescale aus dem Restore-Modus holen und das
-- Datenbankrecht wiederherstellen, das pg_dump ohne --create nicht sichert (GRANT CONNECT aus
-- Migration 0009; die übrigen Datenbankrechte der Quelle, z. B. CONNECT für of_recorder ab 0013,
-- überträgt roles-source.sql aus export-roles.sql). Statistiken baut danach `vacuumdb --analyze-only` (PG 17 überträgt keine).
\set ON_ERROR_STOP on
SELECT timescaledb_post_restore();
-- Produktionsmarker (packages/db/src/guard.ts: reset/down verweigern eine so markierte Datenbank).
-- Der Kommentar reist nicht mit pg_dump/pg_restore in eine bestehende Datenbank → hier setzen.
-- Nur auf dem Ziel; die Quelle (Mac) trägt ihn nie.
DO $$
BEGIN
  EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'orderflow:production');
END
$$;
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO of_api', current_database());
END
$$;
