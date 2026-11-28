-- Big-Trades-Ergänzung finaler Tage auf dem Ziel prüfen bzw. einspielen (deploy/bin/bigtrades-apply.sh;
-- vorher im selben Eingabestrom bigtrades-stage.sql und die Nutzlast aus bigtrades-export.sql).
--
--   -v mode=dry-run   nur lesend: je Tag „would/same/skip“ mit Grund (inkl. v1-Neuberechnung)
--   -v mode=apply     schreibend: je Tag eine Transaktion (siehe bt_apply_day), danach Chunk-Abschluss
--   -v mode=verify    nur lesend: je Tag v2-Digest des Ziels (gespeichert und neu berechnet) = Quelle
-- weitere Variablen: ignore_window (0/1), lock_wait (s, Warten auf den Importer-Lock, Standard 120),
-- lock_timeout (je Tagestransaktion, Standard 2s). Nur für Tests: abort_after (n > 0: die Sitzung
-- beendet sich selbst mitten in der Transaktion des Tages n+1), now_override (Uhrzeit der
-- Fensterprüfung).
--
-- Ausgabezeilen (stdout, „|“-getrennt): info|…, floor|…, check|…, day|<sym>|<tag>|<urteil>|<detail>|<ms>,
-- verify|<sym>|<tag>|<ergebnis>, chunk|…, partial_chunks|n, hot_compressed_chunks|n.
-- Urteile: ok (übertragen), would (dry-run: würde übertragen), same (Ziel hat schon genau diese
-- v2-Daten), skip (passt nicht, unverändert), fail (v2-Gegenprobe gescheitert, zurückgerollt),
-- busy (Sperre nicht in lock_timeout, unverändert – erneut ausführen).
-- Harte Abbrüche (ABBRUCH: …, psql-Exit 3): Untergrenze/Symbol abweichend, Nutzlast unvollständig,
-- Migration 0017 fehlt, Finalisierungsfenster, offene komprimierte Chunks, Importer-Lock belegt
-- oder verloren, andere Admin-/Dump-Sitzungen aktiv.
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off
\if :{?mode}
\else
\set mode dry-run
\endif
\if :{?ignore_window}
\else
\set ignore_window 0
\endif
\if :{?lock_wait}
\else
\set lock_wait 120
\endif
\if :{?lock_timeout}
\else
\set lock_timeout 2s
\endif
\if :{?abort_after}
\else
\set abort_after 0
\endif
\if :{?now_override}
\else
\set now_override ''
\endif

-- Importer-Lock (apps/importer/src/writer/postgres.ts IMPORTER_LOCK_KEY): Session-Advisory-Lock,
-- den Importer und Recorder-Finalisierung (über den Importer) halten, solange sie schreiben.
SELECT set_config('ofb_bt.lock_key', '7042025', false) IS NOT NULL AS _ \gset
SELECT set_config('ofb_bt.lock_timeout', :'lock_timeout', false) IS NOT NULL AS _ \gset

CREATE FUNCTION pg_temp.bt_abort(p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ABBRUCH: %', p_msg USING ERRCODE = 'OFB01';
END
$$;

CREATE FUNCTION pg_temp.bt_lock_held() RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS (SELECT 1 FROM pg_locks
                  WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND classid = 0
                    AND objid = current_setting('ofb_bt.lock_key')::bigint AND objsubid = 1)
$$;

CREATE FUNCTION pg_temp.bt_line(p_verdict text, p_sym smallint, p_day date, p_detail text, p_t0 timestamptz)
RETURNS text LANGUAGE sql AS $$
  SELECT 'day|' || coalesce((SELECT name FROM pg_temp.bt_floor WHERE sym_id = p_sym), p_sym::text) || '|'
         || p_day || '|' || p_verdict || '|' || coalesce(p_detail, '') || '|'
         || round(extract(epoch FROM clock_timestamp() - p_t0) * 1000) || 'ms'
$$;

-- Urteil für einen Tag, ohne zu schreiben. p_lock: data_day-Zeile FOR UPDATE sperren (zuerst
-- data_day, dann – in bt_apply_day – symbol: Reihenfolge von Recorder und Importer, Migration 0017).
-- Übertragen wird nur, wenn das Ziel nachweislich dieselben Aggregate hat: gleicher finaler Zustand,
-- Digest-Version 1, gespeicherter v1-Digest UND neu berechneter day_digest_all_v(…, 1) = lokaler
-- v1-Digest, gleiche Klassifikation (quality_digest), noch keine Order-Daten.
CREATE FUNCTION pg_temp.bt_classify(p_sym smallint, p_day date, p_lock boolean,
                                    OUT verdict text, OUT detail text)
LANGUAGE plpgsql AS $$
DECLARE
  l pg_temp.bt_day%ROWTYPE;
  s record;
  v1 text;
BEGIN
  SELECT * INTO l FROM pg_temp.bt_day WHERE sym_id = p_sym AND day = p_day;
  IF p_lock THEN
    SELECT state, stale, digest, digest_version, quality_digest, state_before_import, orders_n,
           orders_notional, big_floor_n
      INTO s FROM data_day WHERE sym_id = p_sym AND day = p_day FOR UPDATE;
  ELSE
    SELECT state, stale, digest, digest_version, quality_digest, state_before_import, orders_n,
           orders_notional, big_floor_n
      INTO s FROM data_day WHERE sym_id = p_sym AND day = p_day;
  END IF;
  IF NOT FOUND THEN
    verdict := 'skip'; detail := 'Tag fehlt auf dem Ziel'; RETURN;
  END IF;
  IF s.digest_version = 2 THEN
    -- schon Version 2 (übertragen oder vom Recorder/Importer finalisiert): nie überschreiben
    IF s.digest = l.digest_v2 AND s.state = l.state THEN
      verdict := 'same'; detail := 'v2 identisch';
    ELSE
      verdict := 'skip'; detail := 'Ziel hat schon Digest-Version 2 mit anderem Digest/Zustand (' || s.state || ')';
    END IF;
    RETURN;
  END IF;
  verdict := 'skip';
  IF s.state NOT IN ('final_ok', 'final_bad') THEN
    detail := 'Ziel nicht final (' || s.state || ')'; RETURN;
  END IF;
  IF s.state <> l.state THEN
    detail := 'Zustand ' || s.state || ' ≠ lokal ' || l.state; RETURN;
  END IF;
  IF s.stale THEN detail := 'Ziel veraltet (stale)'; RETURN; END IF;
  IF s.state_before_import IS NOT NULL THEN detail := 'Import auf dem Ziel offen'; RETURN; END IF;
  IF s.digest_version IS DISTINCT FROM 1 THEN
    detail := 'Digest-Version ' || coalesce(s.digest_version::text, 'NULL'); RETURN;
  END IF;
  IF s.orders_n IS NOT NULL OR s.orders_notional IS NOT NULL OR s.big_floor_n IS NOT NULL THEN
    detail := 'v1-Tag mit Ordersummen (unerwartet)'; RETURN;
  END IF;
  IF s.digest IS DISTINCT FROM l.digest_v1 THEN
    detail := 'gespeicherter v1-Digest ≠ lokal'; RETURN;
  END IF;
  IF s.quality_digest IS DISTINCT FROM l.quality_digest THEN
    detail := 'Klassifikation (quality_digest) ≠ lokal'; RETURN;
  END IF;
  v1 := day_digest_all_v(p_sym, p_day, 1);
  IF v1 IS DISTINCT FROM l.digest_v1 THEN
    detail := 'Tabelleninhalt v1 (day_digest_all_v) ≠ lokal'; RETURN;
  END IF;
  verdict := 'transfer'; detail := 'v1 bewiesen';
END
$$;

-- Ein Tag in einer Transaktion (psql-Autocommit: ein \gexec-Befehl = eine Transaktion):
-- Lock prüfen → data_day FOR UPDATE → symbol FOR SHARE (Untergrenze) → big_order des Tages
-- ersetzen → data_day-Felder + version + 1 (neue dataVersion/ETags der API) → Σ-Abgleich mit
-- bar_1m → day_digest_all_v(…, 2) = lokaler v2-Digest. Abweichung: Teiltransaktion zurück, „fail“.
-- Direktes DML auch auf Columnstore-Chunks (wie der Importer im Online-Betrieb, MVCC-sicher für
-- Leser); teilweise komprimierte Chunks verdichtet danach bt_finish_chunk unter Sperre.
CREATE FUNCTION pg_temp.bt_apply_day(p_sym smallint, p_day date, p_abort boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  l pg_temp.bt_day%ROWTYPE;
  c record;
  d0 timestamptz := p_day::timestamp AT TIME ZONE 'UTC';
  d1 timestamptz := (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  n_del bigint;
  n_ins bigint;
  bars numeric;
  v2 text;
BEGIN
  PERFORM set_config('lock_timeout', current_setting('ofb_bt.lock_timeout'), true);
  -- DML auf einem Columnstore-Tag entpackt Batches; Timescales Grenze (100 000) aufheben (Importer)
  PERFORM set_config('timescaledb.max_tuples_decompressed_per_dml_transaction', '0', true);
  IF NOT pg_temp.bt_lock_held() THEN
    PERFORM pg_temp.bt_abort('Importer-Lock nicht mehr gehalten (Verbindung neu aufgebaut?)');
  END IF;
  SELECT * INTO l FROM pg_temp.bt_day WHERE sym_id = p_sym AND day = p_day;
  BEGIN
    c := pg_temp.bt_classify(p_sym, p_day, true);
    PERFORM 1 FROM symbol WHERE sym_id = p_sym AND big_floor_n = l.big_floor_n FOR SHARE;
    IF NOT FOUND THEN
      PERFORM pg_temp.bt_abort(format('symbol.big_floor_n (sym_id %s) ≠ lokal %s', p_sym, l.big_floor_n));
    END IF;
    IF c.verdict <> 'transfer' THEN
      RETURN pg_temp.bt_line(c.verdict, p_sym, p_day, c.detail, t0);
    END IF;
    BEGIN
      DELETE FROM big_order WHERE sym_id = p_sym AND ts >= d0 AND ts < d1;
      GET DIAGNOSTICS n_del = ROW_COUNT;
      INSERT INTO big_order (sym_id, ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n)
      SELECT sym_id, ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n
        FROM pg_temp.bt_order WHERE sym_id = p_sym AND ts >= d0 AND ts < d1
       ORDER BY ts, first_agg_id;
      GET DIAGNOSTICS n_ins = ROW_COUNT;
      IF n_ins <> l.n_orders THEN
        RAISE EXCEPTION 'big_order: % Zeilen eingefügt, Nutzlast meldet %', n_ins, l.n_orders USING ERRCODE = 'OFB02';
      END IF;
      UPDATE data_day
         SET orders_n = l.orders_n, orders_notional = l.orders_notional, big_floor_n = l.big_floor_n,
             digest = l.digest_v2, digest_version = 2, version = version + 1
       WHERE sym_id = p_sym AND day = p_day;
      SELECT coalesce(sum(notional), 0) INTO bars FROM bar_1m WHERE sym_id = p_sym AND ts >= d0 AND ts < d1;
      IF bars <> l.orders_notional THEN
        RAISE EXCEPTION 'Σ Notional Orders % ≠ Σ bar_1m.notional %', l.orders_notional, bars USING ERRCODE = 'OFB02';
      END IF;
      IF p_abort THEN -- nur Test: Verbindungsabbruch mitten in der Transaktion
        PERFORM pg_terminate_backend(pg_backend_pid());
        PERFORM pg_sleep(10);
      END IF;
      v2 := day_digest_all_v(p_sym, p_day, 2);
      IF v2 IS DISTINCT FROM l.digest_v2 THEN
        RAISE EXCEPTION 'v2-Digest ≠ lokal (big_order %, order_day %)',
          CASE WHEN day_digest('big_order', p_sym, p_day) = l.d_big THEN 'gleich' ELSE 'abweichend' END,
          CASE WHEN day_digest('order_day', p_sym, p_day) = l.d_ord THEN 'gleich' ELSE 'abweichend' END
          USING ERRCODE = 'OFB02';
      END IF;
    EXCEPTION WHEN SQLSTATE 'OFB02' THEN
      RETURN pg_temp.bt_line('fail', p_sym, p_day, SQLERRM || ' – zurückgerollt', t0);
    END;
    RETURN pg_temp.bt_line('ok', p_sym, p_day, format('orders=%s ersetzt=%s', n_ins, n_del), t0);
  EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
    RETURN pg_temp.bt_line('busy', p_sym, p_day, SQLSTATE || ' (Sperre nicht binnen '
                           || current_setting('ofb_bt.lock_timeout') || ' bzw. Deadlock) – unverändert', t0);
  END;
END
$$;

-- Chunk in den Columnstore wandeln bzw. nachverdichten über of_recompress_chunk (0014/0017:
-- ACCESS EXCLUSIVE, wartet auf Leser) – je Versuch höchstens 500 ms Sperrwartezeit (unter der
-- lock_timeout der API), bis zu 10 Versuche mit Pausen 1…5 s, wie der Importer (convertChunk).
CREATE FUNCTION pg_temp.bt_finish_chunk(p_chunk regclass) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
BEGIN
  FOR i IN 1..10 LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '500ms', true);
      PERFORM public.of_recompress_chunk(p_chunk);
      RETURN 'chunk|' || p_chunk || '|columnstore|Versuch ' || i || '|'
             || round(extract(epoch FROM clock_timestamp() - t0) * 1000) || 'ms';
    EXCEPTION WHEN lock_not_available THEN
      IF i = 10 THEN
        RETURN 'chunk|' || p_chunk || '|deferred|Sperre nicht bekommen (Leser aktiv) – erneut ausführen';
      END IF;
      PERFORM pg_sleep(least(5, i));
    END;
  END LOOP;
  RETURN NULL;
END
$$;

-- Probelauf/verify je Tag als eigene lesende Anweisung (READ COMMITTED, Autocommit): kein
-- Snapshot über den ganzen Lauf – eine gleichzeitige Chunk-Konvertierung (Finalisierung,
-- recorder.sh repair) kann so höchstens die Anweisung eines Tages (≈ 0,2–0,4 s) treffen.
CREATE FUNCTION pg_temp.bt_dry_day(p_sym smallint, p_day date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  t0 timestamptz := clock_timestamp();
  c record;
  n bigint;
BEGIN
  c := pg_temp.bt_classify(p_sym, p_day, false);
  IF c.verdict <> 'transfer' THEN
    RETURN pg_temp.bt_line(c.verdict, p_sym, p_day, c.detail, t0);
  END IF;
  SELECT count(*) INTO n FROM big_order o
   WHERE o.sym_id = p_sym AND o.ts >= p_day::timestamp AT TIME ZONE 'UTC'
     AND o.ts < (p_day + 1)::timestamp AT TIME ZONE 'UTC';
  RETURN pg_temp.bt_line('would', p_sym, p_day, format('%s orders=%s ziel_vorhanden=%s', c.detail,
                         (SELECT n_orders FROM pg_temp.bt_day WHERE sym_id = p_sym AND day = p_day), n), t0);
END
$$;
CREATE FUNCTION pg_temp.bt_verify_day(p_sym smallint, p_day date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  b pg_temp.bt_day%ROWTYPE;
  d record;
  r text;
BEGIN
  SELECT * INTO b FROM pg_temp.bt_day WHERE sym_id = p_sym AND day = p_day;
  SELECT digest, digest_version, state INTO d FROM data_day WHERE sym_id = p_sym AND day = p_day;
  r := CASE WHEN NOT FOUND THEN 'fehlt'
            WHEN d.digest_version IS DISTINCT FROM 2 THEN 'v' || coalesce(d.digest_version::text, 'NULL')
            WHEN d.digest IS DISTINCT FROM b.digest_v2 THEN 'gespeichert_abweichend'
            WHEN d.state <> b.state THEN 'zustand_abweichend'
            WHEN day_digest_all_v(p_sym, p_day, 2) IS DISTINCT FROM b.digest_v2 THEN 'tabellen_abweichend'
            ELSE 'match' END;
  RETURN 'verify|' || (SELECT name FROM pg_temp.bt_floor WHERE sym_id = p_sym) || '|' || p_day || '|' || r;
END
$$;

-- ---------------------------------------------------------------- gemeinsame Prüfungen
SELECT :'mode' = 'apply' AS is_apply, :'mode' = 'dry-run' AS is_dry, :'mode' = 'verify' AS is_verify,
       :'mode' IN ('apply', 'dry-run', 'verify') AS mode_ok \gset
\if :mode_ok
\else
SELECT pg_temp.bt_abort('unbekannter Modus ' || :'mode');
\endif
SELECT to_regclass('public.big_order') IS NOT NULL
       AND to_regprocedure('public.day_digest_all_v(smallint,date,integer)') IS NOT NULL
       AND to_regprocedure('public.of_recompress_chunk(regclass)') IS NOT NULL
       AND to_regprocedure('public.of_hot_margin()') IS NOT NULL AS has_0017 \gset
\if :has_0017
\else
SELECT pg_temp.bt_abort('Migration 0017 (big_order, day_digest_all_v) fehlt auf dem Ziel');
\endif

-- Nutzlast vollständig: genau eine Kopfzeile, Tage und Orders wie gezählt, je Tag n_orders
ANALYZE pg_temp.bt_day;
ANALYZE pg_temp.bt_order;
SELECT (SELECT count(*) FROM pg_temp.bt_meta) = 1
       AND (SELECT format FROM pg_temp.bt_meta) = 1
       AND (SELECT days FROM pg_temp.bt_meta) = (SELECT count(*) FROM pg_temp.bt_day)
       AND NOT EXISTS (SELECT 1 FROM pg_temp.bt_day d LEFT JOIN pg_temp.bt_floor f USING (sym_id)
                        WHERE f.sym_id IS NULL OR d.big_floor_n <> f.big_floor_n)
       AND ((SELECT kind FROM pg_temp.bt_meta) = 'manifest'
            OR ((SELECT orders FROM pg_temp.bt_meta) = (SELECT count(*) FROM pg_temp.bt_order)
                AND NOT EXISTS (
                  SELECT 1 FROM pg_temp.bt_day d
                   WHERE d.n_orders <> (SELECT count(*) FROM pg_temp.bt_order o
                                         WHERE o.sym_id = d.sym_id
                                           AND o.ts >= d.day::timestamp AT TIME ZONE 'UTC'
                                           AND o.ts < (d.day + 1)::timestamp AT TIME ZONE 'UTC'))))
         AS payload_ok,
       (SELECT kind = 'full' FROM pg_temp.bt_meta) AS payload_full \gset
\if :payload_ok
\else
SELECT pg_temp.bt_abort('Nutzlast unvollständig oder inkonsistent (Kopfzeile/Zählungen)');
\endif
SELECT 'info|payload|' || kind || '|Tage=' || days || '|Orders=' || orders || '|' || src_from || '…' || src_to
       || '|erstellt ' || created_at FROM pg_temp.bt_meta;

-- Untergrenze und Symbolzuordnung (sym_id ↔ Name) gleich wie lokal – sonst Abbruch (alle Modi)
SELECT 'floor|' || f.name || '|lokal=' || f.big_floor_n || '|ziel=' || coalesce(s.big_floor_n::text, 'NULL') || '|'
       || CASE WHEN s.sym_id IS NULL THEN 'FEHLT' WHEN s.name <> f.name THEN 'NAME ' || s.name
               WHEN s.big_floor_n IS DISTINCT FROM f.big_floor_n THEN 'ABWEICHEND' ELSE 'ok' END
  FROM pg_temp.bt_floor f LEFT JOIN symbol s USING (sym_id) ORDER BY f.sym_id;
SELECT count(*) > 0 AS floor_bad FROM pg_temp.bt_floor f LEFT JOIN symbol s USING (sym_id)
 WHERE s.sym_id IS NULL OR s.name <> f.name OR s.big_floor_n IS DISTINCT FROM f.big_floor_n \gset
\if :floor_bad
SELECT pg_temp.bt_abort('symbol.big_floor_n bzw. Symbolzuordnung auf dem Ziel ≠ lokal (floor|-Zeilen) – nichts übertragen');
\endif

-- Finalisierungsfenster (Recorder: ab 06:00 UTC des Folgetags, alle 15 min bis zum Erfolg): nicht
-- 05:00–06:00 UTC starten, und ab 06:00 erst, wenn der Vortag aller Symbole der Nutzlast final ist.
SELECT coalesce(nullif(:'now_override', '')::timestamptz, now()) AS bt_now \gset
SELECT CASE
         WHEN t >= '05:00' AND t < '06:00' THEN 'vor_finalisierung'
         WHEN t >= '06:00' AND EXISTS (
                SELECT 1 FROM data_day d
                 WHERE d.sym_id IN (SELECT sym_id FROM pg_temp.bt_floor) AND d.day = dd - 1
                   AND d.state NOT IN ('final_ok', 'final_bad')) THEN 'finalisierung_ausstehend'
         ELSE 'ok' END AS bt_window,
       t::text AS bt_utc
  FROM (SELECT (n AT TIME ZONE 'UTC')::time AS t, (n AT TIME ZONE 'UTC')::date AS dd
          FROM (SELECT :'bt_now'::timestamptz AS n) a) b \gset
SELECT 'check|fenster|' || :'bt_window' || '|UTC ' || :'bt_utc';
SELECT :'bt_window' = 'ok' OR :'ignore_window' = '1' AS window_ok \gset

-- Offene komprimierte Chunks (Prädikat wie sql/hot-chunks.sql) und teilweise komprimierte Chunks
-- (Status-Bit 8) der Projekttabellen
\set chunk_sel 'SELECT format(''%I.%I'', c.chunk_schema, c.chunk_name) AS chunk, c.hypertable_name AS ht, c.range_start, c.range_end, c.is_compressed, k.status FROM timescaledb_information.chunks c JOIN _timescaledb_catalog.chunk k ON k.relid = format(''%I.%I'', c.chunk_schema, c.chunk_name)::regclass WHERE c.hypertable_schema = ''public'' AND c.hypertable_name IN (''fp_1m'', ''fp_1m_b10'', ''fp_5m_b10'', ''fp_15m_b100'', ''fp_1h_b10'', ''fp_1h_b100'', ''fp_1d_b100'', ''fp_1d_b1000'', ''bar_1m'', ''bar_1h'', ''bar_1d'', ''kline_1m'', ''big_order'') AND (k.status & 4) = 0 AND NOT k.osm_chunk'
SELECT count(*) FILTER (WHERE (status & 1) <> 0 AND range_end > now() - public.of_hot_margin()) AS n_hot,
       count(*) FILTER (WHERE (status & 8) <> 0) AS n_partial
  FROM (:chunk_sel) x \gset
SELECT 'check|chunks|offen_komprimiert=' || :n_hot || '|teilweise=' || :n_partial;

-- Importer-Lock: wer hält ihn gerade?
SELECT coalesce(string_agg('pid ' || a.pid || ' ' || coalesce(nullif(a.application_name, ''), '?') || ' ('
                           || coalesce(a.usename::text, '?') || ')', ', '), 'frei') AS lock_holder
  FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory' AND l.granted AND l.classid = 0 AND l.objsubid = 1
   AND l.objid = current_setting('ofb_bt.lock_key')::bigint
   AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database()) \gset
SELECT 'check|importer_lock|' || :'lock_holder';

-- ---------------------------------------------------------------- dry-run
\if :is_dry
SET default_transaction_read_only = on;
SELECT format('SELECT pg_temp.bt_dry_day(%s::smallint, %L::date)', sym_id, day)
  FROM pg_temp.bt_day ORDER BY day, sym_id \gexec
RESET default_transaction_read_only;
\endif

-- ---------------------------------------------------------------- verify
\if :is_verify
SET default_transaction_read_only = on;
SELECT format('SELECT pg_temp.bt_verify_day(%s::smallint, %L::date)', sym_id, day)
  FROM pg_temp.bt_day ORDER BY day, sym_id \gexec
RESET default_transaction_read_only;
\endif

-- ---------------------------------------------------------------- apply
\if :is_apply
\if :payload_full
\else
SELECT pg_temp.bt_abort('Nutzlast ohne big_order-Zeilen (manifest) – für den Lauf mit Orders exportieren');
\endif
\if :window_ok
\else
SELECT pg_temp.bt_abort('Finalisierungsfenster (' || :'bt_window' || ', UTC ' || :'bt_utc'
                        || '): später erneut, oder bewusst mit --ignore-window');
\endif
SELECT :n_hot > 0 AS hot_bad \gset
\if :hot_bad
SELECT pg_temp.bt_abort(:n_hot || ' offene komprimierte Chunks – zuerst deploy/recorder.sh repair (RUNBOOK)');
\endif
-- Keine laufenden Prüfberichte/Dumps/Restores (eine Chunk-Konvertierung ist für ältere
-- Snapshots nicht sicher; wie recorder-ctl.sh guard_no_snapshot_readers)
SELECT count(*) AS n_readers,
       coalesce(string_agg('pid ' || pid || ' ' || coalesce(nullif(application_name, ''), '?'), ', '), '') AS readers
  FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
   AND (application_name IN ('psql', 'pg_dump', 'pg_restore', 'vacuumdb')
        OR (usename = 'of_admin' AND application_name NOT LIKE 'orderflow-%'))
   AND state <> 'idle' \gset
SELECT :n_readers > 0 AS readers_bad \gset
\if :readers_bad
SELECT pg_temp.bt_abort('laufende Admin-/psql-/Dump-Sitzungen: ' || :'readers' || ' – nie parallel zu Transfer/Prüfbericht');
\endif
-- Importer-Lock erwerben (Session-Lock, hält bis zum Ende dieser Sitzung bzw. pg_advisory_unlock);
-- belegt: bis lock_wait Sekunden warten, dann Abbruch. Die Recorder-Finalisierung meldet in der
-- Zeit „lock_busy“ und versucht es 15 min später erneut.
SELECT set_config('ofb_bt.lock_wait', :'lock_wait', false) IS NOT NULL AS _ \gset
DO $$
DECLARE
  w int := current_setting('ofb_bt.lock_wait')::int;
BEGIN
  FOR i IN 0..w LOOP
    IF pg_try_advisory_lock(current_setting('ofb_bt.lock_key')::bigint) THEN
      RETURN;
    END IF;
    IF i < w THEN PERFORM pg_sleep(1); END IF;
  END LOOP;
  PERFORM pg_temp.bt_abort(format('Importer-Lock belegt (Importer oder Recorder-Finalisierung läuft), %s s gewartet', w));
END
$$;
SELECT 'check|importer_lock|erworben';
SELECT 'info|start|' || count(*) || ' Tage' FROM pg_temp.bt_day;
-- je Tag eine Transaktion; Reihenfolge Tag, Symbol
SELECT format('SELECT pg_temp.bt_apply_day(%s::smallint, %L::date, %L::boolean)', sym_id, day,
              :abort_after > 0 AND rn = :abort_after + 1)
  FROM (SELECT sym_id, day, row_number() OVER (ORDER BY day, sym_id) AS rn FROM pg_temp.bt_day) x
 ORDER BY rn \gexec
-- Chunk-Abschluss (unter dem Importer-Lock): alle teilweise komprimierten kalten Chunks der
-- Projekttabellen (wie PostgresWriter.close) und kalte, nicht komprimierte big_order-Chunks im
-- Zeitraum der Nutzlast (neu angelegt). Offene Chunks bleiben im Rowstore (Migration 0015).
SELECT coalesce(min(day), DATE '1970-01-01') AS bt_from, coalesce(max(day) + 1, DATE '1970-01-01') AS bt_to
  FROM pg_temp.bt_day \gset
-- Zweite Prüfung direkt vor der Konvertierung (Prädikat wie importer otherOpenTransactions,
-- apps/importer/src/maintenance.ts): jede andere offene Transaktion außer kurzen API-/Recorder-
-- Zugriffen (< 5 s) – z. B. ein inzwischen gestarteter Prüfbericht oder Probelauf. Dann keine
-- Konvertierung: Chunks bleiben teilweise (lesbar), Exit 4, später erneut ausführen.
SELECT count(*) > 0 AS open_tx,
       coalesce(string_agg('pid ' || pid || ' ' || coalesce(nullif(application_name, ''), '?'), ', '), '') AS open_list
  FROM pg_stat_activity
 WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
   AND xact_start IS NOT NULL
   AND NOT (application_name IN ('orderflow-api', 'orderflow-api-catalog', 'orderflow-recorder')
            AND xact_start >= statement_timestamp() - interval '5 seconds') \gset
\if :open_tx
SELECT 'check|chunk_abschluss|zurückgestellt|offene Transaktionen: ' || :'open_list';
\else
SELECT format('SELECT pg_temp.bt_finish_chunk(%L::regclass)', chunk)
  FROM (:chunk_sel) x
 WHERE range_end <= now() - public.of_hot_margin()
   AND ((status & 8) <> 0
        OR (ht = 'big_order' AND NOT is_compressed
            AND range_start < :'bt_to'::date::timestamp AT TIME ZONE 'UTC'
            AND range_end > :'bt_from'::date::timestamp AT TIME ZONE 'UTC'))
 ORDER BY ht, range_start \gexec
\endif
SELECT pg_advisory_unlock(current_setting('ofb_bt.lock_key')::bigint) AS _ \gset
\endif

-- ---------------------------------------------------------------- Endzustand (alle Modi)
SELECT 'partial_chunks|' || count(*) FILTER (WHERE (status & 8) <> 0) FROM (:chunk_sel) x;
SELECT 'hot_compressed_chunks|' || count(*) FILTER (WHERE (status & 1) <> 0 AND range_end > now() - public.of_hot_margin())
  FROM (:chunk_sel) x;
SELECT 'big_order_chunks_cold_uncompressed|' || count(*) FILTER (WHERE ht = 'big_order' AND NOT is_compressed
                                                                  AND range_end <= now() - public.of_hot_margin())
  FROM (:chunk_sel) x;
