-- Live-Recorder (KONZEPT §2.1, §3.8, §4.2, §4.3; Phase P3).
--
-- Hinweis zu Datenmigrationen wie 0008 (Review H2): 0008 setzt voraus, dass der Vortag nach dem
-- Tag selbst nicht neu importiert wurde (auf der damaligen DB gegeben). Künftige Nachträge dieser
-- Art müssen zusätzlich `p.imported_at <= d.imported_at` verlangen, sonst übernehmen sie Ausgaben
-- eines später geänderten Vortags.

-- Betriebszustand je Komponente und Symbol (Recorder alle ~10 s; Health/Monitor liest).
CREATE TABLE ingest_status (
  component         text        NOT NULL,
  sym_id            smallint    NOT NULL REFERENCES symbol (sym_id),
  last_agg_id       bigint,
  last_trade_ms     bigint,
  ws_connected      boolean,
  open_gaps         integer,
  unwritten_minutes integer,
  rest_weight_1m    integer,     -- zuletzt gemeldetes X-MBX-USED-WEIGHT-1M
  spool_lag_ms      bigint,      -- Alter des ältesten nicht per fsync gesicherten Trades
  last_committed_minute timestamptz,
  last_finalised_day date,
  details           jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component, sym_id)
);

-- Provisorische Tage: bis wohin der Recorder vollständige Minuten geschrieben hat.
ALTER TABLE data_day
  ADD COLUMN live_until   timestamptz,   -- Ende der letzten geschriebenen Minute (exklusiv)
  ADD COLUMN live_minutes integer;       -- Anzahl geschriebener Minuten mit Trades

-- Kline-Abgleich live geschriebener Minuten (§4.6 auf dem Tag bis jetzt; nicht blockierend).
CREATE TABLE live_kline_check (
  sym_id      smallint    NOT NULL REFERENCES symbol (sym_id),
  ts          timestamptz NOT NULL,
  cls         smallint    NOT NULL,      -- eigene Klasse 1 exact, 2 shift, 3 mismatch, 5 missing
  d_q bigint, d_b bigint, s_q bigint, s_b bigint, cand_q bigint, cand_b bigint,
  kline_vol bigint, kline_taker bigint, kline_trades integer,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sym_id, ts)
);

-- Qualitätskennzahl des Recorders: Vergleich des live geschriebenen Tages mit der offiziellen
-- Tagesdatei vor deren Ersatz (§4.3, Ziel ≥ 99,9 % identische Minuten).
CREATE TABLE recorder_quality (
  sym_id            smallint    NOT NULL REFERENCES symbol (sym_id),
  day               date        NOT NULL,
  compared_at       timestamptz NOT NULL DEFAULT now(),
  live_minutes      integer     NOT NULL,   -- Minuten mit live geschriebener bar_1m-Zeile
  official_minutes  integer     NOT NULL,
  identical_minutes integer     NOT NULL,   -- fp_1m-Zeilen und bar_1m (ohne source/check_state) gleich
  differing_minutes integer     NOT NULL,
  missing_minutes   integer     NOT NULL,   -- offiziell vorhanden, live nicht geschrieben
  extra_minutes     integer     NOT NULL,   -- live vorhanden, offiziell nicht
  tables_equal      jsonb       NOT NULL,   -- je Tabelle: Digest live = Digest offiziell
  first_diff        jsonb,                  -- Beispiele der ersten abweichenden Minuten
  PRIMARY KEY (sym_id, day, compared_at)
);
