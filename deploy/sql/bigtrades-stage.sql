-- Staging der Big-Trades-Nutzlast auf dem Ziel (deploy/bin/bigtrades-apply.sh): temporäre Tabellen
-- dieser Sitzung (verschwinden mit ihr – auch bei einem Abbruch bleibt nichts liegen; of_admin hat
-- TEMPORARY, harden-db.sql). Danach folgt im selben Eingabestrom die Nutzlast (COPY … FROM STDIN
-- aus bigtrades-export.sql) und zuletzt bigtrades-run.sql.
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off
SET timezone = 'UTC';
SET datestyle = 'ISO, YMD';
SET application_name = 'orderflow-bigtrades';
-- eigene Backend-PID für bigtrades-apply.sh (beendet die Sitzung, wenn der Aufrufer wegfällt)
SELECT 'info|backend|' || pg_backend_pid();
CREATE TEMP TABLE bt_meta (
  format     integer     NOT NULL,
  kind       text        NOT NULL,
  created_at timestamptz NOT NULL,
  src_from   date        NOT NULL,
  src_to     date        NOT NULL,
  days       integer     NOT NULL,
  orders     bigint      NOT NULL
);
CREATE TEMP TABLE bt_floor (
  sym_id      smallint PRIMARY KEY,
  name        text     NOT NULL,
  big_floor_n bigint   NOT NULL
);
CREATE TEMP TABLE bt_day (
  sym_id          smallint NOT NULL,
  day             date     NOT NULL,
  state           text     NOT NULL,
  quality_digest  text,
  orders_n        bigint   NOT NULL,
  orders_notional bigint   NOT NULL,
  big_floor_n     bigint   NOT NULL,
  digest_v2       text     NOT NULL,
  digest_v1       text     NOT NULL,
  d_big           text     NOT NULL,
  d_ord           text     NOT NULL,
  n_orders        bigint   NOT NULL,
  PRIMARY KEY (sym_id, day)
);
-- Spalten wie big_order (Migration 0017), ohne Hypertable
CREATE TEMP TABLE bt_order (
  sym_id       smallint    NOT NULL,
  ts           timestamptz NOT NULL,
  first_agg_id bigint      NOT NULL,
  last_agg_id  bigint      NOT NULL,
  side         smallint    NOT NULL,
  px_first     integer     NOT NULL,
  px_last      integer     NOT NULL,
  qty          bigint      NOT NULL,
  notional     bigint      NOT NULL,
  agg_n        integer     NOT NULL,
  PRIMARY KEY (sym_id, ts, first_agg_id)
);
-- Rücknahmeliste (nur Modus revert; bigtrades-apply.sh lädt sie aus revert.tsv, sonst leer)
CREATE TEMP TABLE bt_revert (
  name text NOT NULL,
  day  date NOT NULL,
  PRIMARY KEY (name, day)
);
