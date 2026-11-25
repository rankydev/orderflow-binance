-- Recorder-Nachtrag nach dem Review (W5, Abnahme 8).
--
-- Ein provisorischer Tag, den der Recorder nicht weiter schreibt (nicht füllbare Lücke,
-- Aggregations- oder dauerhafter Schreibfehler, Tag nicht mehr provisional), trägt den Grund;
-- die API kann ihn anzeigen. NULL = wird normal geschrieben.
ALTER TABLE data_day ADD COLUMN live_frozen text;

-- Eigene Rolle des Recorders, ohne DDL (KONZEPT §2.4, Abnahme 8). Kein Passwort im Repo: gesetzt
-- wird es außerhalb (VPS: EnvironmentFile). Der Recorder schreibt provisorische Minuten, Status und
-- Kline-Prüfungen; die tägliche Finalisierung läuft im selben Prozess mit der Importer-Bibliothek
-- und braucht daher auch deren Schreibrechte (Manifest, Klines, Tick-Historie, Issues). Kein
-- CREATE im Schema, kein Eigentum an Tabellen: Spaltenänderungen, Columnstore-Konvertierung und
-- alter_job (nur im --backfill des Importers) sind damit nicht möglich – die Finalisierung im
-- Online-Modus braucht sie nicht (direktes DML, Migration 0005-Funktionen per EXECUTE).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'of_recorder') THEN
    CREATE ROLE of_recorder LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      CONNECTION LIMIT 4;
  END IF;
END
$$;
ALTER ROLE of_recorder SET statement_timeout = '120s';
ALTER ROLE of_recorder SET idle_in_transaction_session_timeout = '300s';
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO of_recorder', current_database());
END
$$;
GRANT USAGE ON SCHEMA public TO of_recorder;
REVOKE CREATE ON SCHEMA public FROM of_recorder;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO of_recorder;
GRANT INSERT, UPDATE, DELETE ON
  fp_1m, fp_1m_b10, fp_5m_b10, fp_15m_b100, fp_1h_b10, fp_1h_b100, fp_1d_b100, fp_1d_b1000,
  bar_1m, bar_1h, bar_1d, kline_1m,
  data_day, data_minute_issue, raw_file, raw_day, symbol_tick_history,
  ingest_status, live_kline_check, recorder_quality
TO of_recorder;
GRANT INSERT ON symbol TO of_recorder;
GRANT EXECUTE ON FUNCTION day_digest(text, smallint, date), day_digest_all(smallint, date) TO of_recorder;
