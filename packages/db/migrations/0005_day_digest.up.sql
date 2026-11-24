-- Digest je (Tabelle, Symbol, UTC-Tag), KONZEPT §4.8: SHA256 über die nach Primärschlüssel
-- sortierten Zeilen in kanonischer Textform. Dient Idempotenz (K8), Transferprüfung und
-- Mac/VPS-Gleichlauf. Die Textform ist die Postgres-Zeilentext-Darstellung ROW(<Spalten>)::text
-- (alle Spalten sind Ganzzahlen bzw. timestamptz); Zeitzone und Datumsstil sind an die Funktion
-- gebunden, damit das Ergebnis nicht von der Sitzung abhängt. Zeilen mit '\n' verbunden, ohne
-- abschließendes '\n'; leerer Tag = SHA256('').
--
-- Spalten explizit statt t::text (P1-Korrektur): bar_1m.check_state gehört NICHT in den Digest.
-- Die Klassifikation ist eine Prüfaussage über die Daten; sie ändert sich, wenn ein Nachbartag
-- abgeglichen wird (edge_pending → exact/shift), ohne dass sich Daten ändern – mit check_state
-- wären Re-Import-Digests (K8) und Monats-/Tagesdatei-Gleichwertigkeit (§8) vom Importzeitpunkt
-- der Nachbartage abhängig. bar_1m.source bleibt enthalten (Herkunft live vs. vision ist Inhalt).
-- Der Importer (packages/core/src/digest.ts) berechnet dieselbe Textform ohne Datenbank und prüft
-- in der Import-Transaktion day_digest_all gegen seinen eigenen Digest.
CREATE FUNCTION day_digest(p_table text, p_sym smallint, p_day date)
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

-- Kombinierter Tages-Digest (data_day.digest): SHA256 über "tabelle:digest"-Zeilen in fester
-- Reihenfolge (identisch mit DIGEST_TABLES in packages/core/src/digest.ts).
CREATE FUNCTION day_digest_all(p_sym smallint, p_day date)
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
