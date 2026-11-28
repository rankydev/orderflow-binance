-- Big-Trades-Ergänzung finaler Tage exportieren (Mac, nur lesend; deploy/transfer-bigtrades.sh über
-- deploy/bin/bigtrades-export.sh). Ausgabe auf stdout = Nutzlast für deploy/sql/bigtrades-stage.sql:
-- COPY-Abschnitte für die temporären Tabellen bt_floor, bt_day, bt_order, bt_meta.
--
--   psql -X -At -v ON_ERROR_STOP=1 -v from=2026-06-10 -v to=2026-11-26 -v with_orders=1 \
--        -f bigtrades-export.sql > payload.sql
--
-- Ausgewählt werden Tage mit vollständigen Order-Daten in Digest-Version 2: final_ok/final_bad,
-- nicht veraltet, kein laufender Import, Ordersummen und Untergrenze gesetzt, Untergrenze = die des
-- Symbols. Je Tag geht mit: der gespeicherte v2-Digest (nach einer Gegenprobe gegen die Tabellen,
-- sonst Abbruch), der hier berechnete v1-Digest (Beweis-Schlüssel für das Ziel: dort müssen die
-- zwölf Aggregattabellen exakt diesen v1-Digest ergeben) und die Teil-Digests big_order/order_day
-- (nur für die Fehlermeldung auf dem Ziel). Alles in EINER lesenden Momentaufnahme.
-- with_orders=0: nur die Tagesliste (für --dry-run/--verify; bt_order bleibt leer).
-- Laufzeit ≈ 0,4 s je Tag (v1 + v2 über alle Digest-Tabellen), gemessen 0,19 s je Digest-Version.
\set ON_ERROR_STOP on
\set QUIET on
\pset footer off
\if :{?with_orders}
\else
\set with_orders 1
\endif
SET timezone = 'UTC';
SET datestyle = 'ISO, YMD';
SET extra_float_digits = 0;
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

-- Auswahl (einmal definiert, in jeder Abfrage gleich): (sym_id, day) der zu übertragenden Tage
\set sel 'SELECT d.sym_id, d.day FROM data_day d JOIN symbol s ON s.sym_id = d.sym_id WHERE d.day BETWEEN ' :'from' '::date AND ' :'to' '::date AND d.state IN (''final_ok'', ''final_bad'') AND d.digest_version = 2 AND NOT d.stale AND d.state_before_import IS NULL AND d.orders_n IS NOT NULL AND d.orders_notional IS NOT NULL AND d.big_floor_n IS NOT NULL AND d.big_floor_n = s.big_floor_n'

-- Finale Tage im Zeitraum, die NICHT ausgewählt sind (lokal noch v1, veraltet, andere Untergrenze …)
SELECT count(*) AS n_unsel, count(*) > 0 AS has_unsel,
       coalesce(string_agg(s.name || ' ' || d.day || ' (v' || coalesce(d.digest_version::text, '-')
                           || CASE WHEN d.stale THEN ', stale' ELSE '' END
                           || CASE WHEN d.orders_n IS NULL THEN ', ohne Ordersummen' ELSE '' END
                           || CASE WHEN d.big_floor_n IS DISTINCT FROM s.big_floor_n
                                   THEN ', Untergrenze ' || coalesce(d.big_floor_n::text, 'NULL') ELSE '' END
                           || ')', ', ' ORDER BY d.day, d.sym_id), '') AS unsel
  FROM data_day d JOIN symbol s ON s.sym_id = d.sym_id
 WHERE d.day BETWEEN :'from'::date AND :'to'::date AND d.state IN ('final_ok', 'final_bad')
   AND (d.sym_id, d.day) NOT IN (:sel) \gset
\if :has_unsel
\warn 'WARNUNG: ' :n_unsel ' finale Tage im Zeitraum werden nicht exportiert: ' :unsel
\endif

-- Gegenprobe der Quelle: gespeicherter v2-Digest = Tabelleninhalt (sonst wäre der Beweis wertlos)
SELECT count(*) AS n_days,
       count(*) FILTER (WHERE day_digest_all_v(x.sym_id, x.day, 2) IS DISTINCT FROM d.digest) > 0 AS bad_src,
       coalesce(min(x.day)::text, '-') AS d_min, coalesce(max(x.day)::text, '-') AS d_max
  FROM (:sel) x JOIN data_day d ON d.sym_id = x.sym_id AND d.day = x.day \gset
\if :bad_src
DO $$ BEGIN RAISE EXCEPTION 'ABBRUCH: Quelle inkonsistent – gespeicherter v2-Digest ≠ day_digest_all_v(…, 2) für mindestens einen Tag (verify-db prüfen)'; END $$;
\endif
\warn 'Export: ' :n_days ' Tage (' :d_min ' … ' :d_max ')'

\echo '-- orderflow-binance bigtrades payload, format 1'
\echo 'COPY bt_floor (sym_id, name, big_floor_n) FROM STDIN;'
COPY (SELECT sym_id, name, big_floor_n FROM symbol
       WHERE sym_id IN (SELECT sym_id FROM (:sel) x) ORDER BY sym_id) TO STDOUT;
\echo '\\.'

\echo 'COPY bt_day (sym_id, day, state, quality_digest, orders_n, orders_notional, big_floor_n, digest_v2, digest_v1, d_big, d_ord, n_orders) FROM STDIN;'
COPY (SELECT d.sym_id, d.day, d.state, d.quality_digest, d.orders_n, d.orders_notional, d.big_floor_n,
             d.digest, day_digest_all_v(d.sym_id, d.day, 1),
             day_digest('big_order', d.sym_id, d.day), day_digest('order_day', d.sym_id, d.day),
             (SELECT count(*) FROM big_order b
               WHERE b.sym_id = d.sym_id AND b.ts >= d.day::timestamp AT TIME ZONE 'UTC'
                 AND b.ts < (d.day + 1)::timestamp AT TIME ZONE 'UTC')
        FROM (:sel) x JOIN data_day d ON d.sym_id = x.sym_id AND d.day = x.day
       ORDER BY d.day, d.sym_id) TO STDOUT;
\echo '\\.'

\if :with_orders
\echo 'COPY bt_order (sym_id, ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n) FROM STDIN;'
COPY (SELECT b.sym_id, b.ts, b.first_agg_id, b.last_agg_id, b.side, b.px_first, b.px_last, b.qty,
             b.notional, b.agg_n
        FROM (:sel) x
        JOIN big_order b ON b.sym_id = x.sym_id AND b.ts >= x.day::timestamp AT TIME ZONE 'UTC'
                        AND b.ts < (x.day + 1)::timestamp AT TIME ZONE 'UTC'
       ORDER BY b.sym_id, b.ts, b.first_agg_id) TO STDOUT;
\echo '\\.'
\endif

-- Kopfdaten zuletzt (Zählung im selben Snapshot): das Ziel prüft damit die Vollständigkeit
\echo 'COPY bt_meta (format, kind, created_at, src_from, src_to, days, orders) FROM STDIN;'
COPY (SELECT 1, CASE WHEN :with_orders::int = 1 THEN 'full' ELSE 'manifest' END, now(),
             :'from'::date, :'to'::date, count(*),
             coalesce(sum((SELECT count(*) FROM big_order b
                            WHERE b.sym_id = x.sym_id AND b.ts >= x.day::timestamp AT TIME ZONE 'UTC'
                              AND b.ts < (x.day + 1)::timestamp AT TIME ZONE 'UTC')), 0)
        FROM (:sel) x) TO STDOUT;
\echo '\\.'
COMMIT;
