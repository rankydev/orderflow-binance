DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bar_1h', 'bar_1d', 'fp_1d_b100', 'fp_1d_b1000'] LOOP
    EXECUTE format($f$ALTER TABLE %I SET (timescaledb.enable_columnstore = true,
                     timescaledb.segmentby = 'sym_id', timescaledb.orderby = %L)$f$,
                   t, CASE WHEN t LIKE 'fp\_%' THEN 'ts, px' ELSE 'ts' END);
    CALL add_columnstore_policy(t::regclass, after => INTERVAL '7 days', if_not_exists => true);
  END LOOP;
END
$$;

ALTER TABLE data_day
  DROP COLUMN immutable,
  DROP COLUMN state_before_import,
  DROP COLUMN stale,
  DROP COLUMN prev_last_agg_id,
  DROP COLUMN carry_in_origin,
  DROP COLUMN carry_in_b,
  DROP COLUMN carry_in_q,
  DROP COLUMN kline_sha256,
  DROP COLUMN rules_version,
  DROP COLUMN quality_digest;
