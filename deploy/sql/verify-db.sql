-- Deterministischer Prüfbericht einer orderflow-Datenbank (nur lesend). Wird auf der Quelle (Mac)
-- und auf dem Ziel (VPS bzw. Restore-Test) ausgeführt; die beiden Ausgaben müssen bis auf die
-- Zeilen mit dem Präfix "info|" identisch sein (deploy/transfer-db.sh vergleicht sie per diff).
--   psql -X -At -v ON_ERROR_STOP=1 -f deploy/sql/verify-db.sql
-- Laufzeit ≈ 1 s je Tag (day_digest_all liest jeden Tag aus allen zwölf Digest-Tabellen).
\set QUIET on
\pset footer off
SET statement_timeout = 0;
SET timezone = 'UTC';
SET datestyle = 'ISO, YMD';
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Versionen (Restore nur zwischen identischen Versionen, KONZEPT §2.3)
SELECT 'version|postgres_major|' || current_setting('server_version_num')::int / 10000;
SELECT 'version|' || extname || '|' || extversion FROM pg_extension ORDER BY extname;

-- Zeilenzahlen aller Tabellen in public (Hypertables über alle Chunks, auch Columnstore)
-- (query_to_xml statt DO/Temp-Tabelle: bleibt in einer READ-ONLY-Transaktion zulässig)
SELECT 'rows|' || c.relname || '|'
       || (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname),
                                                false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
 WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname;

-- Chunks je Hypertable: Anzahl und davon im Columnstore (Kompression muss erhalten bleiben)
SELECT 'chunks|' || hypertable_name || '|total=' || count(*) || '|columnstore='
       || count(*) FILTER (WHERE is_compressed)
  FROM timescaledb_information.chunks GROUP BY hypertable_name ORDER BY hypertable_name;
-- Chunk-Grenzen (gleiche Chunk-Aufteilung auf beiden Seiten)
SELECT 'chunkrange|' || hypertable_name || '|' || range_start || '|' || range_end || '|'
       || is_compressed
  FROM timescaledb_information.chunks ORDER BY hypertable_name, range_start;

-- Columnstore-Einstellungen und Hypertable-Dimensionen
SELECT 'columnstore|' || hypertable || '|segmentby=' || coalesce(segmentby, '') || '|orderby='
       || coalesce(orderby, '')
  FROM timescaledb_information.hypertable_columnstore_settings ORDER BY hypertable::text;
SELECT 'dimension|' || hypertable_name || '|' || column_name || '|' || time_interval
  FROM timescaledb_information.dimensions ORDER BY hypertable_name, dimension_number;

-- Hintergrund-Jobs der Anwendung (Columnstore-Policies, IDs ≥ 1000); die Standardjobs der
-- Erweiterung (Telemetrie, Statistik-Retention) legt jede Instanz selbst an → nur info
SELECT 'job|' || job_id || '|' || proc_name || '|' || coalesce(hypertable_name, '-') || '|'
       || schedule_interval || '|scheduled=' || scheduled || '|' || coalesce(config::text, '')
       || '|owner=' || owner
  FROM timescaledb_information.jobs WHERE job_id >= 1000 ORDER BY job_id;
SELECT 'info|extjob|' || job_id || '|' || proc_name || '|scheduled=' || scheduled
  FROM timescaledb_information.jobs WHERE job_id < 1000 ORDER BY job_id;

-- data_day vollständig (alle Spalten, sortiert)
SELECT 'data_day|count=' || count(*) || '|from=' || min(day) || '|to=' || max(day) || '|md5='
       || md5(coalesce(string_agg(d::text, E'\n' ORDER BY d.sym_id, d.day), ''))
  FROM data_day d;
SELECT 'data_day_state|' || state || '|' || count(*) FROM data_day GROUP BY state ORDER BY state;

-- Digest je Tag: gespeicherter data_day.digest = day_digest_all über die Tabelleninhalte
-- (dieselbe Prüfung wie `import --db --verify-db`, ohne Node und ohne Rohdaten)
WITH d AS (SELECT sym_id, day, digest AS stored, day_digest_all(sym_id, day) AS actual
             FROM data_day)
SELECT CASE WHEN g.k = 0 THEN
         'digest|days=' || count(*) || '|match=' || count(*) FILTER (WHERE stored = actual)
         || '|mismatch=' || count(*) FILTER (WHERE stored IS DISTINCT FROM actual)
         || '|md5=' || md5(coalesce(string_agg(sym_id || ':' || day || ':' || actual, E'\n'
                                                 ORDER BY sym_id, day), ''))
       ELSE coalesce(string_agg('digest_mismatch|' || sym_id || '|' || day || '|stored='
                                || coalesce(stored, 'NULL') || '|actual=' || actual, E'\n'
                                ORDER BY sym_id, day) FILTER (WHERE stored IS DISTINCT FROM actual),
                     'digest_mismatch|none') END
  FROM d CROSS JOIN (VALUES (0), (1)) AS g (k) GROUP BY g.k ORDER BY g.k;

-- Inhalt der kleinen Tabellen (ohne Hypertables, ohne data_day)
SELECT 'content|' || c.relname || '|'
       || (xpath('/row/h/text()', query_to_xml(format(
             'SELECT md5(coalesce(string_agg(x::text, E''\n'' ORDER BY x::text), '''')) AS h FROM public.%I x',
             c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
 WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'data_day'
   AND c.relname NOT IN (SELECT hypertable_name FROM timescaledb_information.hypertables)
 ORDER BY c.relname;

-- Migrationsbuchführung (applied_at ist Inhalt der Quelle und wird mit übertragen)
SELECT 'migration|' || version || '|' || name || '|' || checksum FROM schema_migrations ORDER BY version;

-- Nur lesende API-Rolle: Attribute, Rolleneinstellungen, Rechte
SELECT 'role|' || rolname || '|super=' || rolsuper || '|login=' || rolcanlogin || '|inherit='
       || rolinherit || '|createdb=' || rolcreatedb || '|createrole=' || rolcreaterole
       || '|replication=' || rolreplication || '|bypassrls=' || rolbypassrls || '|connlimit='
       || rolconnlimit || '|config=' || coalesce(array_to_string(ARRAY(SELECT unnest(rolconfig) ORDER BY 1), ','), '')
  FROM pg_roles WHERE rolname = 'of_api';
SELECT 'grant|of_api|connect=' || has_database_privilege('of_api', current_database(), 'CONNECT')
       || '|create_db=' || has_database_privilege('of_api', current_database(), 'CREATE')
       || '|schema_usage=' || has_schema_privilege('of_api', 'public', 'USAGE')
       || '|schema_create=' || has_schema_privilege('of_api', 'public', 'CREATE');
SELECT 'grant|of_api|tables=' || count(*)
       || '|select=' || count(*) FILTER (WHERE has_table_privilege('of_api', c.oid, 'SELECT'))
       || '|write=' || count(*) FILTER (WHERE has_table_privilege('of_api', c.oid,
                                              'INSERT,UPDATE,DELETE,TRUNCATE'))
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
 WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p', 'v');
SELECT 'default_acl|' || pg_get_userbyid(defaclrole) || '|' || defaclobjtype::text || '|'
       || array_to_string(defaclacl, ',')
  FROM pg_default_acl ORDER BY 1;
-- Datenbankrechte und -einstellungen (pg_dump ohne --create sichert sie nicht → post-restore.sql;
-- timescaledb.restoring=on hieße: timescaledb_post_restore() fehlt)
SELECT 'datacl|' || coalesce(array_to_string(ARRAY(SELECT unnest(datacl)::text ORDER BY 1), ','), 'default')
  FROM pg_database WHERE datname = current_database();
SELECT 'dbsetting|' || coalesce(pg_get_userbyid(nullif(setrole, 0)), '*') || '|'
       || array_to_string(ARRAY(SELECT unnest(setconfig) ORDER BY 1), ',')
  FROM pg_db_role_setting
 WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
    OR (setdatabase = 0 AND setrole = (SELECT oid FROM pg_roles WHERE rolname = 'of_api'))
 ORDER BY 1;

-- Informativ (darf abweichen): Größen, Jobzeitpunkte
SELECT 'info|db_size|' || pg_size_pretty(pg_database_size(current_database()));
SELECT 'info|hypertable_size|' || hypertable_name || '|'
       || pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass))
  FROM timescaledb_information.hypertables ORDER BY hypertable_name;
SELECT 'info|job_next_start|' || job_id || '|' || coalesce(next_start::text, '-')
  FROM timescaledb_information.jobs ORDER BY job_id;
COMMIT;
