-- Eine Quelle für die Marge offener Chunks (Review W2) und Policy-Frist darüber (H1).
--
-- of_hot_margin(): Marge, nach der ein Chunk als kalt gilt (Begründung in 0015: Live-Minuten,
-- Finalisierung von d-1 samt Randminute von d-2, ein Tag Verspätung der Tagesdatei). Importer,
-- Recorder, Wartungswerkzeug, Tests und of_recompress_chunk lesen sie von hier.
-- of_chunk_is_hot(chunk): range_end > now() - of_hot_margin().
-- Die Columnstore-Policies komprimieren erst nach 4 Tagen (ein Tag Abstand zur Marge, damit eine
-- Policy nie an der Grenze mit einem gerade noch beschriebenen Chunk zusammenfällt); ein Test
-- verlangt compress_after >= of_hot_margin().
CREATE FUNCTION of_hot_margin() RETURNS interval
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT interval '3 days' $$;

CREATE FUNCTION of_chunk_is_hot(p_chunk regclass) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT i.range_end > now() - public.of_hot_margin()
    FROM timescaledb_information.chunks i
   WHERE format('%I.%I', i.chunk_schema, i.chunk_name)::regclass = p_chunk
$$;
GRANT EXECUTE ON FUNCTION of_hot_margin(), of_chunk_is_hot(regclass) TO of_recorder;

CREATE OR REPLACE FUNCTION of_recompress_chunk(p_chunk regclass) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM 1
    FROM _timescaledb_catalog.chunk k
    JOIN _timescaledb_catalog.hypertable h ON h.id = k.hypertable_id
   WHERE k.relid = p_chunk
     AND h.schema_name = 'public'
     AND h.table_name = ANY (ARRAY[
           'fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10', 'fp_1h_b100',
           'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h', 'bar_1d', 'kline_1m'])
     -- Columnstore aktiviert, vor der Sperre geprüft (Review H4). In 2.31 ist
     -- _timescaledb_catalog.hypertable.compression_state immer 0; maßgeblich ist die Info-Sicht.
     AND EXISTS (SELECT 1 FROM timescaledb_information.hypertables x
                  WHERE x.hypertable_schema = h.schema_name AND x.hypertable_name = h.table_name
                    AND x.compression_enabled)
     AND NOT k.osm_chunk
     AND (k.status & 4) = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'of_recompress_chunk: % ist kein Chunk eines Projekt-Hypertables', p_chunk
      USING ERRCODE = '42501';
  END IF;
  IF public.of_chunk_is_hot(p_chunk) THEN
    RAISE EXCEPTION 'of_recompress_chunk: % ist noch offen (Marge %)', p_chunk, public.of_hot_margin()
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', p_chunk);
  CALL public.convert_to_columnstore(p_chunk, if_not_columnstore => true, recompress => true);
END
$$;

DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT job_id, config FROM timescaledb_information.jobs
     WHERE proc_name IN ('policy_compression', 'policy_columnstore') AND hypertable_schema = 'public'
  LOOP
    PERFORM alter_job(j.job_id, config => j.config || '{"compress_after": "4 days"}'::jsonb);
  END LOOP;
END
$$;
