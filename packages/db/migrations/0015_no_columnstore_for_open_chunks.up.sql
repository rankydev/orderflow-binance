-- Offene Chunks nie im Columnstore (Review nach der lokalen Live-Abnahme).
--
-- Regel: Ein Chunk darf erst komprimiert bzw. nachverdichtet werden, wenn sein Zeitraum vollständig
-- vorbei ist und zusätzlich die Marge HOT = 3 Tage verstrichen ist (range_end <= now() - 3 days).
-- Die Marge deckt jeden regulären Schreibzugriff ab: Live-Minuten (heute), Finalisierung von d-1
-- ab 06:00 UTC des Folgetags samt Randminute 1439 von d-2, und eine um bis zu einen weiteren Tag
-- verspätete Binance-Tagesdatei. Sie ist identisch mit compress_after aller Columnstore-Policies
-- (3 days); die Policy vergleicht mit range_end (in 2.31 nachgestellt: ein offener 30-Tage-Chunk
-- wird nicht komprimiert). Spätere Schreibzugriffe (Ausfall über Tage, erzwungener Re-Import)
-- treffen kalte, komprimierte Chunks und laufen über direktes DML + gesperrte Nachverdichtung.
--
-- of_recompress_chunk lehnt heiße Chunks nun ab (vor jeder Sperre), als zweite Verteidigungslinie
-- hinter den Abfragen des Importers.
CREATE OR REPLACE FUNCTION of_recompress_chunk(p_chunk regclass) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_end timestamptz;
BEGIN
  SELECT i.range_end INTO v_end
    FROM _timescaledb_catalog.chunk k
    JOIN _timescaledb_catalog.hypertable h ON h.id = k.hypertable_id
    JOIN timescaledb_information.chunks i
      ON format('%I.%I', i.chunk_schema, i.chunk_name)::regclass = k.relid
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
  IF v_end > now() - interval '3 days' THEN
    RAISE EXCEPTION 'of_recompress_chunk: % ist noch offen (Ende %, Marge 3 Tage)', p_chunk, v_end
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', p_chunk);
  CALL public.convert_to_columnstore(p_chunk, if_not_columnstore => true, recompress => true);
END
$$;
