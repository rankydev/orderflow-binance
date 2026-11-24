-- Entzieht der API-Rolle die Rechte in dieser Datenbank. Die Rolle selbst bleibt bestehen, weil sie
-- clusterweit gilt und andere Datenbanken (z. B. orderflow_test) sie noch nutzen können; löschen nur
-- manuell mit DROP ROLE of_api, wenn keine Datenbank mehr Rechte an sie vergibt.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM of_api;
REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM of_api;
REVOKE USAGE ON SCHEMA public FROM of_api;
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM of_api', current_database());
END
$$;
