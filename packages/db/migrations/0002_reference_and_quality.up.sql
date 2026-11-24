-- Referenz-, Manifest- und Qualitätstabellen (KONZEPT §3.1, §3.2, §3.8). Alles normale Tabellen.
-- P1-Umfang: ingest_status gehört zum Recorder (P2) und fehlt hier absichtlich.

CREATE TABLE symbol (
  sym_id         smallint PRIMARY KEY,
  name           text     NOT NULL UNIQUE,         -- 'BTCUSDT'
  price_unit     numeric  NOT NULL CHECK (price_unit > 0),  -- BTC 0.01, ETH 0.001
  price_decimals smallint NOT NULL CHECK (price_decimals >= 0),
  tick_ref_units integer  NOT NULL CHECK (tick_ref_units > 0), -- Referenz-Tick in price_unit
  qty_unit       numeric  NOT NULL CHECK (qty_unit > 0),       -- min(LOT_SIZE, MARKET_LOT_SIZE)
  qty_decimals   smallint NOT NULL CHECK (qty_decimals >= 0),
  big_floor_n    bigint,                           -- Untergrenze big_order, NULL bis P5
  data_from      date     NOT NULL,                -- 2025-01-01
  active         boolean  NOT NULL DEFAULT true
);

CREATE TABLE symbol_tick_history (
  sym_id         smallint NOT NULL REFERENCES symbol (sym_id),
  day            date     NOT NULL,
  min_step_units integer  NOT NULL CHECK (min_step_units > 0),  -- ggT aller px-Differenzen
  PRIMARY KEY (sym_id, day)
);

-- Manifest: eine Zeile je Datei (Sidecar-JSON ist die rekonstruierbare Quelle).
CREATE TABLE raw_file (
  path              text        PRIMARY KEY,   -- relativ unter data/raw/binance-vision/
  sym_id            smallint    NOT NULL REFERENCES symbol (sym_id),
  kind              text        NOT NULL CHECK (kind IN ('aggTrades', 'klines', 'trades')),
  origin            text        NOT NULL CHECK (origin IN ('daily', 'monthly')),
  period            text        NOT NULL,      -- 'YYYY-MM-DD' (daily) bzw. 'YYYY-MM' (monthly)
  bytes             bigint      NOT NULL CHECK (bytes >= 0),
  sha256            text        NOT NULL,
  checksum_expected text,                      -- Inhalt der .CHECKSUM-Datei
  checksum_ok       boolean     NOT NULL,
  header_present    boolean,
  downloaded_at     timestamptz,
  importer_version  text
);

-- Manifest: eine Zeile je Symbol-Tag und Art; Felder für daily und monthly identisch.
CREATE TABLE raw_day (
  sym_id           smallint    NOT NULL REFERENCES symbol (sym_id),
  kind             text        NOT NULL CHECK (kind IN ('aggTrades', 'klines', 'trades')),
  day              date        NOT NULL,
  origin           text        NOT NULL CHECK (origin IN ('daily', 'monthly')),
  origin_path      text        NOT NULL REFERENCES raw_file (path),
  origin_sha256    text        NOT NULL,       -- bei monthly für alle Tage des Monats gleich
  rows             bigint      NOT NULL CHECK (rows >= 0),
  first_agg_id     bigint,                     -- bei klines NULL; bei trades: Trade-ID
  last_agg_id      bigint,
  agg_id_holes     bigint      NOT NULL DEFAULT 0,
  agg_id_dups      bigint      NOT NULL DEFAULT 0,
  ts_backwards     bigint      NOT NULL DEFAULT 0,
  continues_prev   boolean,                    -- first_agg_id = last_agg_id(Vortag) + 1; NULL = kein Vortag
  first_ts         timestamptz,
  last_ts          timestamptz,
  header_present   boolean,
  downloaded_at    timestamptz,
  importer_version text,
  PRIMARY KEY (sym_id, kind, day)
);

-- Zustandsautomat und Qualität je Symbol-Tag (KONZEPT §4.3, §4.6, §4.7).
CREATE TABLE data_day (
  sym_id           smallint NOT NULL REFERENCES symbol (sym_id),
  day              date     NOT NULL,
  state            text     NOT NULL CHECK (state IN (
                     'provisional', 'importing', 'provisional_import_failed', 'final_ok', 'final_bad')),
  version          integer  NOT NULL DEFAULT 0,  -- +1 bei jedem Ersatz; Basis der Cache-Versionen
  source           text     CHECK (source IN ('live', 'live+rest', 'vision')),
  raw_sha256       text,
  rows             bigint,
  first_agg_id     bigint,
  last_agg_id      bigint,
  min_exact        integer,
  min_shift        integer,
  min_mismatch     integer,
  min_missing      integer,
  min_gap          integer,
  edge_pending     boolean,                      -- = edge_first_pending OR edge_last_pending
  edge_first_pending boolean,                    -- Minute 0 wartet auf den Abgleich des Vortags
  edge_last_pending  boolean,                    -- Minute 1439 wartet auf den Abgleich des Folgetags
  carry_q          bigint,                       -- Übertrag s(1439) in den Folgetag (Lots, §4.6)
  carry_b          bigint,
  cand_last_q      bigint,                       -- cand(1439): untere Hüllgrenze für Minute 0 des Folgetags
  cand_last_b      bigint,
  deep_check       text     CHECK (deep_check IN ('passed', 'failed', 'reference_unusable')),
  digest           text,
  importer_version text,
  imported_at      timestamptz,
  verified_at      timestamptz,
  PRIMARY KEY (sym_id, day)
);

CREATE TABLE data_minute_issue (
  sym_id  smallint    NOT NULL REFERENCES symbol (sym_id),
  ts      timestamptz NOT NULL,
  kind    text        NOT NULL CHECK (kind IN ('shift', 'mismatch', 'missing', 'gap')),
  d_q     bigint,
  d_b     bigint,
  cand_q  bigint,
  cand_b  bigint,
  carry_q bigint,
  carry_b bigint,
  PRIMARY KEY (sym_id, ts, kind)
);

CREATE TABLE verify_run (
  run_id     serial      PRIMARY KEY,
  host       text        NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  scope      text        NOT NULL,
  checks     integer     NOT NULL DEFAULT 0,
  mismatches integer     NOT NULL DEFAULT 0,
  report     jsonb
);
