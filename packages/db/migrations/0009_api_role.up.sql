-- Nur lesende Datenbankrolle der API (KONZEPT §2.1, §2.4, §10.2): `of_api` darf ausschließlich lesen.
-- Rollen gelten clusterweit (dieselbe Rolle für orderflow und orderflow_test); die Rechte gelten je
-- Datenbank. Kein Passwort im Repo: die Rolle wird ohne Passwort angelegt; gesetzt wird es außerhalb
-- (lokal: `npm run role:password -w @orderflow/api` aus OF_API_DB_PASSWORD; VPS: per EnvironmentFile).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'of_api') THEN
    CREATE ROLE of_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      CONNECTION LIMIT 16;
  END IF;
END
$$;

-- Schutz auch ohne die Sitzungseinstellungen der API: nur lesende Transaktionen, Obergrenzen für
-- Laufzeit, Sperrwartezeit und offene Transaktionen (die API setzt je Sitzung engere Werte).
ALTER ROLE of_api SET default_transaction_read_only = on;
ALTER ROLE of_api SET statement_timeout = '15s';
ALTER ROLE of_api SET lock_timeout = '5s';
ALTER ROLE of_api SET idle_in_transaction_session_timeout = '60s';

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO of_api', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO of_api;
-- Hypertables: Timescale überträgt die Rechte auf bestehende und künftige Chunks (auch Columnstore).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO of_api;
-- Tabellen, die spätere Migrationen (als Migrationsrolle) anlegen, sind ebenfalls lesbar.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO of_api;
