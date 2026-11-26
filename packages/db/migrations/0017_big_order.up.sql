-- Big Trades, Stufen 1–3 (KONZEPT §3.7, Phase P5; Entscheidung 2026-11-26): Orders nach
-- Order-Regel v1, gespeichert ab einer absoluten Untergrenze je Symbol, als Teil des Tages-Digests.
--
-- 1. big_order: eine Zeile je Order mit notional ≥ symbol.big_floor_n. Chunk 30 Tage (§3.9, wie
--    bar_1m); Columnstore-Policy wie alle Projekttabellen nach 0014/0016: erst nach 4 Tagen,
--    ohne Nachverdichtung durch die Policy (die macht nur of_recompress_chunk unter Sperre).
CREATE TABLE big_order (
  sym_id       smallint    NOT NULL,
  ts           timestamptz NOT NULL,   -- T der Order (ms); alle aggTrades der Order haben dasselbe T
  first_agg_id bigint      NOT NULL,
  last_agg_id  bigint      NOT NULL,
  side         smallint    NOT NULL CHECK (side IN (1, 2)),  -- 1 = Käufer-Aggressor (m=false), 2 = Verkäufer
  px_first     integer     NOT NULL,   -- Preis des ersten / letzten aggTrades (Sweep-Spanne), price_unit
  px_last      integer     NOT NULL,
  qty          bigint      NOT NULL CHECK (qty > 0),        -- Lots
  notional     bigint      NOT NULL CHECK (notional > 0),   -- Σ px·lots (price_unit·qty_unit)
  agg_n        integer     NOT NULL,   -- Anzahl aggTrades (integer statt smallint: kein Überlauf möglich)
  -- Order-Regel v1: aggIds lückenlos fortlaufend
  CHECK (agg_n >= 1 AND last_agg_id - first_agg_id + 1 = agg_n),
  PRIMARY KEY (sym_id, ts, first_agg_id)
);
SELECT create_hypertable('big_order', by_range('ts', INTERVAL '30 days'), create_default_indexes => false);
ALTER TABLE big_order SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'sym_id',
  timescaledb.orderby = 'ts, first_agg_id'
);
CALL add_columnstore_policy('big_order', after => INTERVAL '4 days', if_not_exists => true);
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN
    SELECT job_id, config FROM timescaledb_information.jobs
     WHERE proc_name IN ('policy_compression', 'policy_columnstore')
       AND hypertable_schema = 'public' AND hypertable_name = 'big_order'
  LOOP
    PERFORM alter_job(j.job_id, config => j.config || '{"recompress": false}'::jsonb);
  END LOOP;
END
$$;

-- 2. Rechte: of_api liest big_order über die Standardrechte aus 0009 (Big-Trades-API, P5). Der
--    Recorder schreibt big_order minutenweise (wie bar_1m) und in der Finalisierung.
GRANT INSERT, UPDATE, DELETE ON big_order TO of_recorder;

-- 3. Untergrenze je Symbol (Entscheidung 2026-11-26: absolute Schwelle in USDT; das
--    Perzentil-Modell aus §3.7 kommt später). big_floor_n ist ganzzahliges Notional in
--    price_unit·qty_unit, hier aus den Einheiten der Symbolzeile berechnet: BTCUSDT 500 000 USDT
--    (= 5·10¹⁰ bei 0,01 · 0,001), ETHUSDT 250 000 USDT (= 2,5·10¹¹ bei 0,001 · 0,001). Symbole
--    ohne Zeile (neue Datenbank) behalten NULL: dann bilden Importer und Recorder keine big orders
--    und vermerken big_floor_n NULL am Tag (mit Warnung), bis eine Untergrenze gesetzt ist.
ALTER TABLE symbol ADD CONSTRAINT symbol_big_floor_positive CHECK (big_floor_n IS NULL OR big_floor_n > 0);
UPDATE symbol SET big_floor_n = (500000 / (price_unit * qty_unit))::bigint WHERE name = 'BTCUSDT';
UPDATE symbol SET big_floor_n = (250000 / (price_unit * qty_unit))::bigint WHERE name = 'ETHUSDT';

-- 4. data_day: Ordersummen des Tages über ALLE Orders (Abgleich: Σ notional aller Orders =
--    Σ bar_1m.notional), die beim Schreiben verwendete Untergrenze und die Digest-Version.
--
--    Digest-Version: bisher gespeicherte Digests (Version 1) decken die zwölf Tabellen bis P4 ab
--    und wurden ohne Orders berechnet. Version 2 umfasst zusätzlich big_order und die Ordersummen
--    (`order_day`). Ein Tag wird immer in SEINER Version geprüft (day_digest_all_v):
--    - kein falscher Alarm: ein v1-Tag stimmt in v1 weiter überein (verify-db, Transferprüfung);
--    - kein falsches „match" für Order-Daten: ein v1-Tag hat digest_version = 1 und orders_n NULL,
--      der Importer schreibt ihn beim nächsten Lauf neu („Digest-Version 1→2"). Die API darf
--      big_order nur für Tage mit digest_version ≥ 2 AND big_floor_n IS NOT NULL (Live-Tage:
--      orders_n und big_floor_n nicht NULL) als vorhanden melden; ab welcher Größe, sagt
--      data_day.big_floor_n. Live-Tage: orders_n NULL = Summen unbekannt (Speicher unvollständig).
--    Digest und Version werden immer zusammen gesetzt (Prüfbedingung); ein Schreiber ohne Kenntnis
--    der Version (alter Code nach dieser Migration) scheitert laut statt still v1 zu schreiben.
ALTER TABLE data_day
  ADD COLUMN orders_n        bigint CHECK (orders_n >= 0),
  ADD COLUMN orders_notional bigint CHECK (orders_notional >= 0),
  ADD COLUMN big_floor_n     bigint CHECK (big_floor_n > 0),
  ADD COLUMN digest_version  smallint CHECK (digest_version IN (1, 2));
UPDATE data_day SET digest_version = 1 WHERE digest IS NOT NULL;
ALTER TABLE data_day
  ADD CONSTRAINT data_day_digest_version CHECK ((digest IS NULL) = (digest_version IS NULL));
COMMENT ON COLUMN data_day.orders_n IS
  'Anzahl aller Orders (Order-Regel v1) des Tages; NULL = ohne Order-Daten geschrieben (vor 0017)';
COMMENT ON COLUMN data_day.orders_notional IS
  'Σ Notional aller Orders des Tages (= Σ bar_1m.notional), price_unit·qty_unit';
COMMENT ON COLUMN data_day.big_floor_n IS
  'Untergrenze, mit der big_order für diesen Tag geschrieben wurde; NULL = keine big orders gebildet';
COMMENT ON COLUMN data_day.digest_version IS
  '1 = zwölf Tabellen (bis P4), 2 = zusätzlich big_order und order_day; Prüfung mit day_digest_all_v';

-- 5. Digest-Funktionen. day_digest kennt big_order (Reihenfolge des Primärschlüssels) und
--    `order_day` (die Zeile sym_id, day, orders_n, orders_notional, big_floor_n aus data_day).
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
  IF p_table = 'order_day' THEN
    SELECT encode(sha256(convert_to(coalesce(string_agg(
             ROW(sym_id, day, orders_n, orders_notional, big_floor_n)::text, E'\n'), ''), 'UTF8')), 'hex')
      INTO v_digest
      FROM data_day
     WHERE sym_id = p_sym AND day = p_day;
    RETURN v_digest;
  END IF;
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
    WHEN p_table = 'big_order'
      THEN 'sym_id, ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n'
    ELSE NULL
  END;
  IF v_cols IS NULL THEN
    RAISE EXCEPTION 'day_digest: unbekannte Tabelle %', p_table;
  END IF;
  v_order := CASE
    WHEN p_table LIKE 'fp\_%' THEN 'ts, px'
    WHEN p_table = 'big_order' THEN 'ts, first_agg_id'
    ELSE 'ts'
  END;

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

-- Kombinierter Tages-Digest einer bestimmten Version: SHA256 über "teil:digest"-Zeilen in fester
-- Reihenfolge (identisch mit DIGEST_TABLES_V1 bzw. DIGEST_TABLES in packages/core/src/digest.ts).
CREATE FUNCTION day_digest_all_v(p_sym smallint, p_day date, p_version integer)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_parts  text[];
  v_digest text;
BEGIN
  v_parts := CASE p_version
    WHEN 1 THEN ARRAY['fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10', 'fp_1h_b100',
                      'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h', 'bar_1d', 'kline_1m']
    WHEN 2 THEN ARRAY['fp_1m', 'fp_1m_b10', 'fp_5m_b10', 'fp_15m_b100', 'fp_1h_b10', 'fp_1h_b100',
                      'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h', 'bar_1d', 'kline_1m',
                      'big_order', 'order_day']
  END;
  IF v_parts IS NULL THEN
    RAISE EXCEPTION 'day_digest_all_v: unbekannte Digest-Version %', p_version;
  END IF;
  SELECT encode(sha256(convert_to(
           string_agg(u.t || ':' || day_digest(u.t, p_sym, p_day), E'\n' ORDER BY u.ord), 'UTF8')), 'hex')
    INTO v_digest
    FROM unnest(v_parts) WITH ORDINALITY AS u (t, ord);
  RETURN v_digest;
END
$$;

-- day_digest_all = aktuelle Version (Import-Transaktion: Gegenprobe zum TS-Digest).
CREATE OR REPLACE FUNCTION day_digest_all(p_sym smallint, p_day date)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT day_digest_all_v(p_sym, p_day, 2)
$$;
GRANT EXECUTE ON FUNCTION day_digest_all_v(smallint, date, integer) TO of_recorder;

-- 6. of_recompress_chunk (Fassung 0016) mit big_order in der Liste der Projekt-Hypertables.
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
           'fp_1d_b100', 'fp_1d_b1000', 'bar_1m', 'bar_1h', 'bar_1d', 'kline_1m', 'big_order'])
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
