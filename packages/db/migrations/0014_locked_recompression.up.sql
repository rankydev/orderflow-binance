-- Nachverdichtung teilweise komprimierter Chunks nur noch unter Sperre (Recorder-Review K1, W4).
--
-- 1. Die Columnstore-Policy verdichtet teilweise komprimierte Chunks (Status-Bit 8, nach DML auf
--    einem Columnstore-Chunk) in 2.31 nach, ohne auf Leser zu warten; ein Leser mit älterem Snapshot
--    sieht den Chunk dabei leer – auch mit LOCK TABLE … ACCESS SHARE vor dem Snapshot (gemessen).
--    `recompress: false` nimmt der Policy genau diesen Teil weg; die Erstkompression gealterter
--    Chunks bleibt (sie wartet auf ACCESS SHARE und ließ ältere Snapshots in Messungen intakt).
--    Teilweise komprimierte Chunks verdichtet nur noch der Importer über of_recompress_chunk.
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT job_id, config FROM timescaledb_information.jobs
     WHERE proc_name IN ('policy_compression', 'policy_columnstore') AND hypertable_schema = 'public'
  LOOP
    PERFORM alter_job(j.job_id, config => j.config || '{"recompress": false}'::jsonb);
  END LOOP;
END
$$;

-- 2. Chunk eines Projekt-Hypertables in den Columnstore wandeln bzw. nachverdichten – unter
--    ACCESS EXCLUSIVE (wartet auf laufende Leser; die lock_timeout des Aufrufers gilt). Nur der
--    Eigentümer des Hypertables darf konvertieren; der Recorder (of_recorder, ohne Eigentum)
--    finalisiert aber im selben Prozess mit der Importer-Bibliothek. Daher SECURITY DEFINER mit
--    festem search_path, und das Argument muss ein Chunk eines der Projekt-Hypertables sein
--    (geprüft gegen den Timescale-Katalog; eingefrorene und OSM-Chunks nicht).
CREATE FUNCTION of_recompress_chunk(p_chunk regclass) RETURNS void
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
REVOKE ALL ON FUNCTION of_recompress_chunk(regclass) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION of_recompress_chunk(regclass) TO of_recorder;

-- 3. Künftige Tabellen (vom Migrationsbenutzer angelegt) sind für den Recorder mindestens lesbar;
--    Schreibrechte bleiben eine ausdrückliche Entscheidung der jeweiligen Migration. Der Test
--    „of_recorder: jede Tabelle hat eine ausdrückliche Entscheidung" schlägt bei einer neuen Tabelle
--    ohne Eintrag fehl.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO of_recorder;

-- 4. live_until / live_minutes bleiben nach der Finalisierung als Herkunftsangabe stehen (was der
--    Recorder live geschrieben hatte); live_frozen setzt der Importer beim finalen Schreiben zurück.
COMMENT ON COLUMN data_day.live_until IS
  'Ende der letzten live geschriebenen Minute (exklusiv); bleibt nach der Finalisierung als Herkunft stehen';
COMMENT ON COLUMN data_day.live_minutes IS
  'Anzahl live geschriebener Minuten; bleibt nach der Finalisierung als Herkunft stehen';
COMMENT ON COLUMN data_day.live_frozen IS
  'Grund, warum der Recorder einen provisorischen Tag nicht weiter schreibt; NULL sonst und nach der Finalisierung';
