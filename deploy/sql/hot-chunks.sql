-- Offene („heiße") Chunks im Columnstore auflisten – nur lesend, ohne Sperren auf Tabellen.
-- Prädikat wie `importer repair-open-chunks` (apps/importer/src/maintenance.ts, Migration 0015):
-- Projekt-Hypertable, Status-Bit 1 (ganz oder teilweise komprimiert), nicht eingefroren (Bit 4),
-- kein OSM-Chunk, range_end > now() - Marge. Marge 3 Tage = HOT_MARGIN des Importers (0015).
-- Ab Migration 0016 kommt die Marge aus public.of_hot_margin() (eine Quelle für Importer, Recorder
-- und diese Prüfung); vorher gilt das Literal 3 Tage (= HOT_MARGIN aus 0015).
--   psql -X -At -v ON_ERROR_STOP=1 -f hot-chunks.sql   (bzw. deploy/bin/hot-chunks.sh)
-- Ausgabe: je Chunk „hot|<chunk>|<hypertable>|<range_end>|status=<n>", zuletzt „hot_count|<n>".
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off
SELECT CASE WHEN to_regprocedure('public.of_hot_margin()') IS NULL THEN 'interval ''3 days'''
            ELSE 'public.of_hot_margin()' END AS hot_margin_expr \gset
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
-- Prädikat genau einmal (CTE); Liste und Anzahl aus derselben Momentaufnahme
WITH hot AS (
  SELECT format('%I.%I', c.chunk_schema, c.chunk_name) AS chunk, c.hypertable_name AS ht,
         c.range_start, c.range_end, k.status
    FROM timescaledb_information.chunks c
    JOIN _timescaledb_catalog.chunk k ON k.relid = format('%I.%I', c.chunk_schema, c.chunk_name)::regclass
   WHERE c.hypertable_schema = 'public'
     AND c.hypertable_name IN ('fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10',
                               'fp_1h_b100', 'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h',
                               'bar_1d', 'kline_1m')
     AND (k.status & 1) <> 0 AND (k.status & 4) = 0 AND NOT k.osm_chunk
     AND c.range_end > now() - :hot_margin_expr
)
SELECT line FROM (
  SELECT 0 AS o, ht AS h, range_start AS r,
         'hot|' || chunk || '|' || ht || '|' || range_end || '|status=' || status AS line
    FROM hot
  UNION ALL
  SELECT 1, '', NULL, 'hot_count|' || count(*) FROM hot
) x ORDER BY o, h, r;
COMMIT;
