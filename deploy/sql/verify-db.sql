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
-- Optional: im exportierten Snapshot des Dumps lesen (psql -v snapshot=<id>, transfer-db.sh), damit
-- zwischen Dump und Bericht laufende Jobs/Importe auf der Quelle keinen Fehlalarm auslösen.
\if :{?snapshot}
SET TRANSACTION SNAPSHOT :'snapshot';
\endif

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
-- Erweiterung (Telemetrie, Statistik-Retention) legt jede Instanz selbst an → nur info.
-- `scheduled` steht nicht hier: restore-db.sh pausiert die Jobs des Ziels während des Berichts und
-- hängt den Zustand danach als jobsched|-Zeilen an (transfer-db.sh ebenso für die Quelle).
SELECT 'job|' || job_id || '|' || proc_name || '|' || coalesce(hypertable_name, '-') || '|'
       || schedule_interval || '|' || coalesce(config::text, '')
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
-- Anwendungsrollen (of_api ab 0009, of_recorder ab 0013): Attribute, Einstellungen, Rechte.
-- Zeilen nur für Rollen, die existieren – auf beiden Seiten gleich, wenn roles-source.sql stimmt.
SELECT 'role|' || rolname || '|super=' || rolsuper || '|login=' || rolcanlogin || '|inherit='
       || rolinherit || '|createdb=' || rolcreatedb || '|createrole=' || rolcreaterole
       || '|replication=' || rolreplication || '|bypassrls=' || rolbypassrls || '|connlimit='
       || rolconnlimit || '|config=' || coalesce(array_to_string(ARRAY(SELECT unnest(rolconfig) ORDER BY 1), ','), '')
  FROM pg_roles WHERE rolname IN ('of_api', 'of_recorder') ORDER BY rolname;
SELECT 'grant|' || r.rolname || '|connect=' || has_database_privilege(r.oid, current_database(), 'CONNECT')
       || '|create_db=' || has_database_privilege(r.oid, current_database(), 'CREATE')
       || '|temp=' || has_database_privilege(r.oid, current_database(), 'TEMPORARY')
       || '|schema_usage=' || has_schema_privilege(r.oid, 'public', 'USAGE')
       || '|schema_create=' || has_schema_privilege(r.oid, 'public', 'CREATE')
  FROM pg_roles r WHERE r.rolname IN ('of_api', 'of_recorder') ORDER BY r.rolname;
SELECT 'grant|' || r.rolname || '|tables=' || count(*)
       || '|select=' || count(*) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'SELECT'))
       || '|write=' || count(*) FILTER (WHERE has_table_privilege(r.oid, c.oid,
                                              'INSERT,UPDATE,DELETE,TRUNCATE'))
       || '|insert=' || count(*) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'INSERT'))
       || '|update=' || count(*) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'UPDATE'))
       || '|delete=' || count(*) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'DELETE'))
       || '|truncate=' || count(*) FILTER (WHERE has_table_privilege(r.oid, c.oid, 'TRUNCATE'))
       || '|owner=' || count(*) FILTER (WHERE c.relowner = r.oid)
  FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
 WHERE r.rolname IN ('of_api', 'of_recorder') AND s.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
 GROUP BY r.rolname ORDER BY r.rolname;
-- Welche Tabellen jede Rolle schreiben darf (Liste, damit eine Verschiebung auffällt)
SELECT 'grant_write|' || r.rolname || '|' || coalesce(string_agg(c.relname, ',' ORDER BY c.relname), '')
  FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
 WHERE r.rolname IN ('of_api', 'of_recorder') AND s.nspname = 'public' AND c.relkind IN ('r', 'p')
   AND has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE')
 GROUP BY r.rolname ORDER BY r.rolname;
-- Projektfunktionen in public (nicht die der Timescale-Erweiterung): wer darf sie ausführen,
-- welche sind SECURITY DEFINER (z. B. of_recompress_chunk ab Migration 0014)
SELECT 'grant_exec|' || r.rolname || '|' || coalesce(string_agg(p.oid::regprocedure::text, ',' ORDER BY p.oid::regprocedure::text), '')
  FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
 WHERE r.rolname IN ('of_api', 'of_recorder') AND s.nspname = 'public'
   AND NOT EXISTS (SELECT FROM pg_depend dp WHERE dp.classid = 'pg_proc'::regclass AND dp.objid = p.oid AND dp.deptype = 'e')
   AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
 GROUP BY r.rolname ORDER BY r.rolname;
SELECT 'function|' || p.oid::regprocedure::text || '|owner=' || pg_get_userbyid(p.proowner)
       || '|body=' || CASE WHEN p.prokind IN ('f', 'p') THEN md5(pg_get_functiondef(p.oid)) ELSE md5(p.prosrc) END
       || '|secdef=' || p.prosecdef || '|config=' || coalesce(array_to_string(p.proconfig, ','), '')
       || '|acl=' || coalesce(array_to_string(ARRAY(SELECT unnest(p.proacl)::text ORDER BY 1), ','), 'default')
  FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
 WHERE s.nspname = 'public'
   AND NOT EXISTS (SELECT FROM pg_depend dp WHERE dp.classid = 'pg_proc'::regclass AND dp.objid = p.oid AND dp.deptype = 'e')
 ORDER BY 1;
SELECT 'default_acl|' || pg_get_userbyid(defaclrole) || '|'
       || CASE WHEN defaclnamespace = 0 THEN '*' ELSE defaclnamespace::regnamespace::text END || '|'
       || defaclobjtype::text || '|'
       || array_to_string(ARRAY(SELECT unnest(defaclacl)::text ORDER BY 1), ',')
  FROM pg_default_acl ORDER BY 1;
-- Rollenmitgliedschaften der Anwendungsrollen (direkt), sortiert
SELECT 'member|' || r.rolname || '|'
       || coalesce((SELECT string_agg(g.rolname, ',' ORDER BY g.rolname)
                      FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                     WHERE m.member = r.oid), '')
  FROM pg_roles r WHERE r.rolname IN ('of_api', 'of_recorder') ORDER BY r.rolname;
-- Datenbankrechte und -einstellungen (pg_dump ohne --create sichert sie nicht → post-restore.sql;
-- timescaledb.restoring=on hieße: timescaledb_post_restore() fehlt)
SELECT 'datacl|' || coalesce(array_to_string(ARRAY(SELECT unnest(datacl)::text ORDER BY 1), ','), 'default')
  FROM pg_database WHERE datname = current_database();
SELECT 'dbsetting|' || coalesce(pg_get_userbyid(nullif(setrole, 0)), '*') || '|'
       || array_to_string(ARRAY(SELECT unnest(setconfig) ORDER BY 1), ',')
  FROM pg_db_role_setting
 WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
    OR (setdatabase = 0 AND setrole IN (SELECT oid FROM pg_roles WHERE rolname IN ('of_api', 'of_recorder')))
 ORDER BY 1;

-- Informativ (darf abweichen): Größen, Jobzeitpunkte
SELECT CASE WHEN to_regprocedure('public.of_hot_margin()') IS NULL THEN 'interval ''3 days'''
            ELSE 'public.of_hot_margin()' END AS hot_margin_expr \gset
-- Offene („heiße") Chunks im Columnstore (Prädikat wie hot-chunks.sql / repair-open-chunks): nur
-- informativ, weil die Zahl von der Uhrzeit abhängt (now() − Marge, ab 0016 of_hot_margin()) und Quell- und Zielbericht zu
-- verschiedenen Zeiten laufen. Den Zustand selbst vergleichen die chunkrange|-Zeilen exakt (Grenzen
-- + is_compressed). Die harte Prüfung „0" gehört nach repair-open-chunks und vor den
-- Recorder-Start (deploy/bin/hot-chunks.sh --require-zero), nicht in einen Transfer.
SELECT 'info|hot_compressed_chunks|' || count(*) || '|'
       || coalesce(string_agg(format('%I.%I', c.chunk_schema, c.chunk_name), ',' ORDER BY c.chunk_name), '')
  FROM timescaledb_information.chunks c
  JOIN _timescaledb_catalog.chunk k ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
 WHERE c.hypertable_schema = 'public'
   AND c.hypertable_name IN ('fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10',
                             'fp_1h_b100', 'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h',
                             'bar_1d', 'kline_1m')
   AND (k.status & 1) <> 0 AND (k.status & 4) = 0 AND NOT k.osm_chunk
   AND c.range_end > now() - :hot_margin_expr;
SELECT 'info|db_size|' || pg_size_pretty(pg_database_size(current_database()));
SELECT 'info|hypertable_size|' || hypertable_name || '|'
       || pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass))
  FROM timescaledb_information.hypertables ORDER BY hypertable_name;
SELECT 'info|job_next_start|' || job_id || '|' || coalesce(next_start::text, '-')
  FROM timescaledb_information.jobs ORDER BY job_id;
COMMIT;
