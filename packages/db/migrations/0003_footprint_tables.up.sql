-- Basistabelle fp_1m und Footprint-Rollups (KONZEPT §3.4, §3.6, §3.9).
-- Chunk-Intervalle und Columnstore-Fristen nach §3.9. Keine Standard-Indizes auf ts:
-- der Primärschlüssel (sym_id, ts, px) deckt alle Abfragen "sym_id = $1 AND ts im Bereich" ab.
-- Hinweis: Jahres-/Monatsintervalle rechnet Timescale in feste Tage um; daher explizit '365 days'.

CREATE TABLE fp_1m (
  sym_id smallint    NOT NULL,
  ts     timestamptz NOT NULL,   -- Minutenbeginn (UTC) nach §3.3
  px     integer     NOT NULL,   -- Preis in price_unit
  buy_q  integer     NOT NULL,   -- Lots, Aggressor Käufer (m=false)
  sell_q integer     NOT NULL,   -- Lots, Aggressor Verkäufer (m=true)
  buy_a  integer     NOT NULL,   -- Anzahl aggTrades
  sell_a integer     NOT NULL,
  PRIMARY KEY (sym_id, ts, px)
);
SELECT create_hypertable('fp_1m', by_range('ts', INTERVAL '1 day'), create_default_indexes => false);
ALTER TABLE fp_1m SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = 'sym_id',
  timescaledb.orderby = 'ts, px'
);
CALL add_columnstore_policy('fp_1m', after => INTERVAL '3 days', if_not_exists => true);

-- Rollups: gleiche Spalten wie fp_1m, Mengen bigint; px = row_px (untere Zeilenkante in price_unit).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('fp_1m_b10',    INTERVAL '7 days',   INTERVAL '3 days'),
      ('fp_5m_b10',    INTERVAL '7 days',   INTERVAL '3 days'),
      ('fp_15m_b100',  INTERVAL '30 days',  INTERVAL '3 days'),
      ('fp_1h_b10',    INTERVAL '30 days',  INTERVAL '3 days'),
      ('fp_1h_b100',   INTERVAL '30 days',  INTERVAL '3 days'),
      ('fp_1d_b100',   INTERVAL '365 days', INTERVAL '7 days'),
      ('fp_1d_b1000',  INTERVAL '365 days', INTERVAL '7 days')
    ) AS t (name, chunk_interval, columnstore_after)
  LOOP
    EXECUTE format($f$
      CREATE TABLE %I (
        sym_id smallint    NOT NULL,
        ts     timestamptz NOT NULL,
        px     integer     NOT NULL,
        buy_q  bigint      NOT NULL,
        sell_q bigint      NOT NULL,
        buy_a  integer     NOT NULL,
        sell_a integer     NOT NULL,
        PRIMARY KEY (sym_id, ts, px)
      )$f$, r.name);
    PERFORM create_hypertable(r.name::regclass, by_range('ts', r.chunk_interval),
                              create_default_indexes => false);
    EXECUTE format($f$
      ALTER TABLE %I SET (
        timescaledb.enable_columnstore = true,
        timescaledb.segmentby = 'sym_id',
        timescaledb.orderby = 'ts, px'
      )$f$, r.name);
    CALL add_columnstore_policy(r.name::regclass, after => r.columnstore_after, if_not_exists => true);
  END LOOP;
END
$$;
