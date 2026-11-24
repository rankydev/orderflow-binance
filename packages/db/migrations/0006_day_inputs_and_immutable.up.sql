-- P1-Nachtrag nach dem ersten DB-Lauf und dem Backend-Review (N2, N3, N4, N5, N6).
--
-- data_day: Eingaben und Ergebnis, mit denen ein Tag geschrieben wurde, damit „fertig" von Daten
-- statt von Codetext abhängt (N3) und ein Nachbartag erkennt, dass er neu klassifiziert werden muss,
-- wenn sich Übertrag oder letzte aggId des Vortags geändert haben (N2).
ALTER TABLE data_day
  ADD COLUMN quality_digest   text,      -- SHA256 der eigenen Klassen je Minute (D, s), §4.6
  ADD COLUMN rules_version    text,      -- RULES_VERSION beim Schreiben (Herkunft; nicht Teil von „fertig")
  ADD COLUMN kline_sha256     text,      -- SHA256 der verwendeten Kline-Tagesdatei
  ADD COLUMN carry_in_q       bigint,    -- verwendeter Übertrag s(−1)
  ADD COLUMN carry_in_b       bigint,
  ADD COLUMN carry_in_origin  text CHECK (carry_in_origin IN ('chain', 'stored', 'neighbour', 'estimated')),
  ADD COLUMN prev_last_agg_id bigint,    -- last_agg_id des Vortags, gegen den continues_prev geprüft wurde
  ADD COLUMN stale            boolean NOT NULL DEFAULT false,  -- Vortag geändert, Neuklassifikation ausstehend
  ADD COLUMN state_before_import text CHECK (state_before_import IN (
                 'provisional', 'provisional_import_failed', 'final_ok', 'final_bad')),  -- für die Wiederherstellung (N4)
  -- Unveränderlich = final, keine offene Randminute, nicht veraltet. Nur solche Tage dürfen in als
  -- `final` gekennzeichnete, dauerhaft gecachte Kacheln eingehen (N6).
  ADD COLUMN immutable boolean GENERATED ALWAYS AS (
    state IN ('final_ok', 'final_bad') AND NOT coalesce(edge_pending, true) AND NOT stale) STORED;

-- N5: Die Jahres-Chunk-Tabellen sind winzig (bar_1h ≤ 8 760 Zeilen/Jahr/Symbol, bar_1d ≤ 365,
-- fp_1d_* einige 10 000). Gemessen über 34 BTC-Tage: 1,8 MB roh gegenüber 0,5 MB komprimiert,
-- hochgerechnet auf 692 Tage × 2 Symbole ≈ 75 MB roh gegenüber ≈ 20 MB. Komprimiert verlangt jeder
-- Re-Import eines historischen Tages ein convert_to_rowstore des ganzen Jahres-Chunks (exklusive
-- Sperre über ein Jahr Lesezugriffe). Daher: kein Columnstore für diese vier Tabellen.
DO $$
DECLARE
  t text;
  c regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY['bar_1h', 'bar_1d', 'fp_1d_b100', 'fp_1d_b1000'] LOOP
    CALL remove_columnstore_policy(t::regclass, if_exists => true);
    FOR c IN SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
               FROM timescaledb_information.chunks
              WHERE hypertable_schema = 'public' AND hypertable_name = t AND is_compressed LOOP
      CALL convert_to_rowstore(c, if_columnstore => true);
    END LOOP;
    EXECUTE format('ALTER TABLE %I SET (timescaledb.enable_columnstore = false)', t);
  END LOOP;
END
$$;
