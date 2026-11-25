-- Funktion in der Fassung von 0014 wiederherstellen (ohne Prüfung auf offene Chunks)
CREATE OR REPLACE FUNCTION of_recompress_chunk(p_chunk regclass) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM _timescaledb_catalog.chunk k
      JOIN _timescaledb_catalog.hypertable h ON h.id = k.hypertable_id
     WHERE k.relid = p_chunk
       AND h.schema_name = 'public'
       AND h.table_name = ANY (ARRAY[
             'fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10', 'fp_1h_b100',
             'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h', 'bar_1d', 'kline_1m'])
       -- Columnstore aktiviert, vor der Sperre geprüft (Review H4). In 2.31 ist
       -- _timescaledb_catalog.hypertable.compression_state immer 0; maßgeblich ist die Info-Sicht.
       AND EXISTS (SELECT 1 FROM timescaledb_information.hypertables i
                    WHERE i.hypertable_schema = h.schema_name AND i.hypertable_name = h.table_name
                      AND i.compression_enabled)
       AND NOT k.osm_chunk
       AND (k.status & 4) = 0
  ) THEN
    RAISE EXCEPTION 'of_recompress_chunk: % ist kein Chunk eines Projekt-Hypertables', p_chunk
      USING ERRCODE = '42501';
  END IF;
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', p_chunk);
  CALL public.convert_to_columnstore(p_chunk, if_not_columnstore => true, recompress => true);
END
$$;
