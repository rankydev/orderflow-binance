-- Rücknahme von 0017. Tage, die mit Digest-Version 2 geschrieben wurden, behalten ihren Digest;
-- day_digest_all rechnet danach wieder Version 1 – solche Tage müssen neu importiert werden.
-- of_recompress_chunk in der Fassung von 0016 (ohne big_order)
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

-- Digest-Funktionen in der Fassung von 0005
CREATE OR REPLACE FUNCTION day_digest_all(p_sym smallint, p_day date)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT encode(sha256(convert_to(
           string_agg(u.t || ':' || day_digest(u.t, p_sym, p_day), E'\n' ORDER BY u.ord), 'UTF8')), 'hex')
    FROM unnest(ARRAY['fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10', 'fp_1h_b100',
                      'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h', 'bar_1d', 'kline_1m'])
         WITH ORDINALITY AS u (t, ord)
$$;
DROP FUNCTION IF EXISTS day_digest_all_v(smallint, date, integer);
CREATE OR REPLACE FUNCTION day_digest(p_table text, p_sym smallint, p_day date)
RETURNS text
LANGUAGE plpgsql
STABLE
SET timezone = 'UTC'
SET datestyle = 'ISO, YMD'
AS $$
DECLARE
  v_cols   text;
  v_order  text;
  v_digest text;
BEGIN
  v_cols := CASE
    WHEN p_table IN ('fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10', 'fp_1h_b100',
                     'fp_1d_b100', 'fp_1d_b1000')
      THEN 'sym_id, ts, px, buy_q, sell_q, buy_a, sell_a'
    WHEN p_table = 'bar_1m'
      THEN 'sym_id, ts, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a, notional, '
           'first_agg_id, last_agg_id, first_trade_ms, last_trade_ms, run_max, run_min, d_from_low, '
           'd_from_high, source'
    WHEN p_table IN ('bar_1h', 'bar_1d')
      THEN 'sym_id, ts, open_px, high_px, low_px, close_px, buy_q, sell_q, buy_a, sell_a, notional, '
           'first_agg_id, last_agg_id, first_trade_ms, last_trade_ms, run_max, run_min, d_from_low, '
           'd_from_high'
    WHEN p_table = 'kline_1m'
      THEN 'sym_id, ts, open_px, high_px, low_px, close_px, vol, taker_buy, trades, quote_vol_n'
    ELSE NULL
  END;
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'day_digest: unbekannte Tabelle %', p_table;
  END IF;
  v_order := CASE WHEN p_table LIKE 'fp\_%' THEN 'ts, px' ELSE 'ts' END;

  EXECUTE format(
    $q$SELECT encode(sha256(convert_to(coalesce(string_agg(ROW(%s)::text, E'\n' ORDER BY %s), ''), 'UTF8')), 'hex')
         FROM %I t
        WHERE sym_id = $1
          AND ts >= ($2::timestamp AT TIME ZONE 'UTC')
          AND ts <  (($2 + 1)::timestamp AT TIME ZONE 'UTC')$q$,
    v_cols, v_order, p_table)
  INTO v_digest
  USING p_sym, p_day;
  RETURN v_digest;
END
$$;

ALTER TABLE data_day
  DROP CONSTRAINT IF EXISTS data_day_digest_version,
  DROP COLUMN IF EXISTS digest_version,
  DROP COLUMN IF EXISTS big_floor_n,
  DROP COLUMN IF EXISTS orders_notional,
  DROP COLUMN IF EXISTS orders_n;
UPDATE symbol SET big_floor_n = NULL;
ALTER TABLE symbol DROP CONSTRAINT IF EXISTS symbol_big_floor_positive;
DROP TABLE IF EXISTS big_order;
