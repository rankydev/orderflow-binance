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
  -- of_recorder (ab Migration 0013) behält sein ausdrückliches CONNECT aus der Migration bzw. aus
  -- roles-source.sql; hier wird nichts hinzugefügt (vor 0013 soll die Rolle nicht verbinden) und
  -- TEMPORARY bekommt sie nie
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'of_recorder') THEN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM of_recorder', current_database());
  END IF;
END
$$;
-- Wartungsdatenbanken: keine Verbindung für Anwendungsrollen (CREATE DATABASE als Superuser geht weiter)
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;
-- Kontrolle: of_api/of_recorder nur mit orderflow verbindbar, nirgends TEMP oder CREATE
SELECT 'dbpriv|' || d.datname || '|' || r.rolname || '_connect='
       || has_database_privilege(r.oid, d.datname, 'CONNECT')
       || '|' || r.rolname || '_temp=' || has_database_privilege(r.oid, d.datname, 'TEMPORARY')
       || '|' || r.rolname || '_create=' || has_database_privilege(r.oid, d.datname, 'CREATE')
  FROM pg_database d CROSS JOIN pg_roles r
 WHERE d.datallowconn AND r.rolname IN ('of_api', 'of_recorder')
 ORDER BY d.datname, r.rolname;
-- Kontrolle: PUBLIC ohne c/T, of_api nur c
SELECT 'datacl|' || array_to_string(ARRAY(SELECT unnest(datacl)::text ORDER BY 1), ',')
  FROM pg_database WHERE datname = current_database();
SELECT 'public_connect|' || has_database_privilege('public', current_database(), 'CONNECT')
       || '|public_temp|' || has_database_privilege('public', current_database(), 'TEMPORARY')
       || '|api_connect|' || has_database_privilege('of_api', current_database(), 'CONNECT')
       || '|api_temp|' || has_database_privilege('of_api', current_database(), 'TEMPORARY');
