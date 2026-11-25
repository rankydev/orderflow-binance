-- Härtung der Server-Datenbank (Auflage aus dem API-Review): niemand außer den ausdrücklich
-- berechtigten Rollen darf sich mit `orderflow` verbinden oder dort temporäre Tabellen anlegen.
-- Nach dem Restore und NACH dem Prüfbericht-Vergleich ausführen (verändert datacl gegenüber der
-- Quelle). Idempotent. Entspricht apps/api/README.md, „Datenbank: Rechte auf Datenbankebene".
\set ON_ERROR_STOP on
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO of_admin', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO of_api', current_database());
END
$$;
-- Wartungsdatenbanken: keine Verbindung für Anwendungsrollen (CREATE DATABASE als Superuser geht weiter)
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;
-- Kontrolle: of_api darf sich nur mit orderflow verbinden und nirgends TEMP anlegen
SELECT 'dbpriv|' || datname || '|of_api_connect=' || has_database_privilege('of_api', datname, 'CONNECT')
       || '|of_api_temp=' || has_database_privilege('of_api', datname, 'TEMPORARY')
  FROM pg_database WHERE datallowconn ORDER BY datname;
-- Kontrolle: PUBLIC ohne c/T, of_api nur c
SELECT 'datacl|' || array_to_string(ARRAY(SELECT unnest(datacl)::text ORDER BY 1), ',')
  FROM pg_database WHERE datname = current_database();
SELECT 'public_connect|' || has_database_privilege('public', current_database(), 'CONNECT')
       || '|public_temp|' || has_database_privilege('public', current_database(), 'TEMPORARY')
       || '|api_connect|' || has_database_privilege('of_api', current_database(), 'CONNECT')
       || '|api_temp|' || has_database_privilege('of_api', current_database(), 'TEMPORARY');
