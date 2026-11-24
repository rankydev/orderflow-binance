-- Bar-Statistik (KONZEPT §3.5) und Kline-Referenz (§3.8); Chunks/Fristen nach §3.9.
-- Minuten ohne Trade haben keine Zeile.

CREATE TABLE bar_1m (
  sym_id         smallint    NOT NULL,
  ts             timestamptz NOT NULL,
  open_px        integer     NOT NULL,
  high_px        integer     NOT NULL,
  low_px         integer     NOT NULL,
  close_px       integer     NOT NULL,
  buy_q          bigint      NOT NULL,
  sell_q         bigint      NOT NULL,
  buy_a          integer     NOT NULL,  -- aggTrades
  sell_a         integer     NOT NULL,
  notional       bigint      NOT NULL,  -- Σ px·lots (für VWAP)
  first_agg_id   bigint      NOT NULL,
  last_agg_id    bigint      NOT NULL,
  first_trade_ms bigint      NOT NULL,
  last_trade_ms  bigint      NOT NULL,
  run_max        bigint      NOT NULL,  -- Maximum des laufenden Deltas nach jedem aggTrade
  run_min        bigint      NOT NULL,
  d_from_low     bigint      NOT NULL,  -- Delta ab erstem aggTrade auf low_px bis Minutenende (COT High)
  d_from_high    bigint      NOT NULL,  -- Delta ab erstem aggTrade auf high_px bis Minutenende (COT Low)
  source         smallint    NOT NULL CHECK (source IN (1, 2, 3)),        -- 1=live 2=live+rest 3=vision
  check_state    smallint    NOT NULL CHECK (check_state BETWEEN 0 AND 4), -- 0 ungeprüft 1 exact 2 shift 3 mismatch 4 edge_pending
  PRIMARY KEY (sym_id, ts)
);
SELECT create_hypertable('bar_1m', by_range('ts', INTERVAL '30 days'), create_default_indexes => false);
ALTER TABLE bar_1m SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'sym_id',
  timescaledb.orderby = 'ts'
);
CALL add_columnstore_policy('bar_1m', after => INTERVAL '3 days', if_not_exists => true);

-- Höhere Zeitrahmen: gleiche Spalten wie bar_1m ohne source/check_state (Minuten-Begriffe; die
-- Qualität liegt in data_day/data_minute_issue). run_max/run_min/d_from_* enthalten hier die
-- Kompositwerte (Max/Min-Delta, COT) über den ganzen Bar (§3.5).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES ('bar_1h'), ('bar_1d')) AS t (name)
  LOOP
    EXECUTE format($f$
      CREATE TABLE %I (
        sym_id         smallint    NOT NULL,
        ts             timestamptz NOT NULL,
        open_px        integer     NOT NULL,
        high_px        integer     NOT NULL,
        low_px         integer     NOT NULL,
        close_px       integer     NOT NULL,
        buy_q          bigint      NOT NULL,
        sell_q         bigint      NOT NULL,
        buy_a          integer     NOT NULL,
        sell_a         integer     NOT NULL,
        notional       bigint      NOT NULL,
        first_agg_id   bigint      NOT NULL,
        last_agg_id    bigint      NOT NULL,
        first_trade_ms bigint      NOT NULL,
        last_trade_ms  bigint      NOT NULL,
        run_max        bigint      NOT NULL,
        run_min        bigint      NOT NULL,
        d_from_low     bigint      NOT NULL,
        d_from_high    bigint      NOT NULL,
        PRIMARY KEY (sym_id, ts)
      )$f$, r.name);
    PERFORM create_hypertable(r.name::regclass, by_range('ts', INTERVAL '365 days'),
                              create_default_indexes => false);
    EXECUTE format($f$
      ALTER TABLE %I SET (
        timescaledb.enable_columnstore = true,
        timescaledb.segmentby = 'sym_id',
        timescaledb.orderby = 'ts'
      )$f$, r.name);
    CALL add_columnstore_policy(r.name::regclass, after => INTERVAL '7 days', if_not_exists => true);
  END LOOP;
END
$$;

-- Referenz aus Vision-Klines, exakt geparst (Anzeige der Trade-Anzahl, Abgleich §4.6).
CREATE TABLE kline_1m (
  sym_id        smallint    NOT NULL,
  ts            timestamptz NOT NULL,
  open_px       integer     NOT NULL,
  high_px       integer     NOT NULL,
  low_px        integer     NOT NULL,
  close_px      integer     NOT NULL,
  vol           bigint      NOT NULL,  -- Lots
  taker_buy     bigint      NOT NULL,  -- Lots
  trades        integer     NOT NULL,
  quote_vol_n   bigint      NOT NULL,  -- ganzzahliges Notional (price_unit·qty_unit)
  PRIMARY KEY (sym_id, ts)
);
SELECT create_hypertable('kline_1m', by_range('ts', INTERVAL '30 days'), create_default_indexes => false);
ALTER TABLE kline_1m SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'sym_id',
  timescaledb.orderby = 'ts'
);
CALL add_columnstore_policy('kline_1m', after => INTERVAL '3 days', if_not_exists => true);
