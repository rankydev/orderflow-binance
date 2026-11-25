-- Clusterweite Rollen vor dem Restore anlegen (pg_dump sichert keine Rollen, nur die GRANTs an sie).
-- Spiegelt den Rollenteil von packages/db/migrations/0009_api_role.up.sql (Attribute und
-- Rolleneinstellungen); die Rechte selbst (GRANT CONNECT/USAGE/SELECT, Default-Privilegien) kommen
-- mit dem Dump. deploy/sql/verify-db.sql vergleicht Attribute und Einstellungen mit der Quelle, eine
-- Abweichung zu 0009 fällt also beim Transfer auf.
-- Kein Passwort hier: gesetzt wird es danach mit dem Werkzeug api-role-password (aus api.env).
-- Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'of_api') THEN
    CREATE ROLE of_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      CONNECTION LIMIT 16;
  END IF;
END
$$;
ALTER ROLE of_api SET default_transaction_read_only = on;
ALTER ROLE of_api SET statement_timeout = '15s';
ALTER ROLE of_api SET lock_timeout = '5s';
ALTER ROLE of_api SET idle_in_transaction_session_timeout = '60s';
