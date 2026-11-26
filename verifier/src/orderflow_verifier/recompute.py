"""Mengenbasierte Neuberechnung eines Symbol-Tages in DuckDB (KONZEPT §3.3–§3.6, §4.8).

Eingabe: Tabelle ``agg`` (exakt geparste aggTrades, auch Nachbartage) und ``kl`` (Klines).
Ausgabe: Tabellen fp_1m, alle Rollups, bar_1m/1h/1d, kline_1m, big_order mit denselben Spalten
wie die Postgres-Tabellen (ts in ms seit Epoche), die Orders des Tages (Order-Regel v1, KONZEPT §3.7)
und Digests in der Textform der SQL-Funktion day_digest, kombiniert je Digest-Version
(day_digest_all_v, Migration 0017).
"""

from __future__ import annotations

import hashlib

import duckdb

from .units import (
    DIGEST_PARTS,
    DIGEST_TABLES,
    DIGEST_VERSION,
    INT32_MAX,
    MS_DAY,
    MS_HOUR,
    MS_MIN,
    ROLLUPS,
    SymbolSpec,
)

FP_COLS = ("ts", "px", "buy_q", "sell_q", "buy_a", "sell_a")
BAR_COLS = (
    "ts open_px high_px low_px close_px buy_q sell_q buy_a sell_a notional first_agg_id "
    "last_agg_id first_trade_ms last_trade_ms run_max run_min d_from_low d_from_high"
).split()
KLINE_COLS = "ts open_px high_px low_px close_px vol taker_buy trades quote_vol_n".split()
BIG_ORDER_COLS = "ts first_agg_id last_agg_id side px_first px_last qty notional agg_n".split()

# Spalten je Tabelle in der Reihenfolge von day_digest (Migration 0005), ohne sym_id.
TABLE_COLS: dict[str, list[str]] = {
    **{t: list(FP_COLS) for t in DIGEST_TABLES if t.startswith("fp_")},
    "bar_1m": [*BAR_COLS, "source"],
    "bar_1h": list(BAR_COLS),
    "bar_1d": list(BAR_COLS),
    "kline_1m": KLINE_COLS,
    "big_order": BIG_ORDER_COLS,
}
ORDER_BY = {
    t: ("ts, px" if t.startswith("fp_") else "ts, first_agg_id" if t == "big_order" else "ts")
    for t in DIGEST_TABLES
}


def build_orders(con: duckdb.DuckDBPyConnection, big_floor_n: int | None) -> dict:
    """Orders des Tages aus ``aggd`` nach Order-Regel v1 und big_order ab ``big_floor_n``.

    Eine Order ist ein maximaler Lauf von aggTrades (nach aggId) mit gleichem T, gleicher Seite m
    und aggId genau Vorgänger + 1; jeder Bruch einer der drei Bedingungen beginnt eine neue Order.
    Notional = Σ px·lots exakt (HUGEINT, dann BIGINT wie in Postgres). ``big_floor_n`` None = keine
    Untergrenze: big_order bleibt leer. Liefert die Tagessummen und die Zerlegungsprüfung.
    """
    if big_floor_n is not None and (not isinstance(big_floor_n, int) or big_floor_n <= 0):
        raise ValueError(f"big_floor_n muss eine positive Ganzzahl sein: {big_floor_n!r}")
    con.execute("DROP TABLE IF EXISTS orders")
    con.execute("DROP TABLE IF EXISTS big_order")
    con.execute(
        """CREATE TABLE orders AS
        WITH x AS (
            SELECT id, px, q, t, m,
                   CASE WHEN lag(id) OVER w = id - 1 AND lag(t) OVER w = t AND lag(m) OVER w = m
                        THEN 0 ELSE 1 END AS brk
            FROM aggd WINDOW w AS (ORDER BY id)),
        g AS (SELECT *, sum(brk) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) AS grp FROM x)
        SELECT min(t) AS ts, max(t) AS t_last, min(id) AS first_agg_id, max(id) AS last_agg_id,
               CASE WHEN bool_and(m) THEN 2 ELSE 1 END AS side, bool_and(m) <> bool_or(m) AS mixed,
               arg_min(px, id) AS px_first, arg_max(px, id) AS px_last,
               CAST(sum(q) AS BIGINT) AS qty,
               CAST(sum(CAST(px AS HUGEINT) * q) AS BIGINT) AS notional,
               CAST(count(*) AS BIGINT) AS agg_n
        FROM g GROUP BY grp"""
    )
    floor_sql = "FALSE" if big_floor_n is None else f"notional >= {int(big_floor_n)}"
    con.execute(
        f"""CREATE TABLE big_order AS
            SELECT ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n
            FROM orders WHERE {floor_sql}"""
    )
    n, ntl, qty, aggs, bad = con.execute(
        """SELECT count(*), coalesce(sum(CAST(notional AS HUGEINT)), 0), coalesce(sum(qty), 0),
                  coalesce(sum(agg_n), 0),
                  count(*) FILTER (WHERE t_last <> ts OR mixed
                                   OR last_agg_id - first_agg_id + 1 <> agg_n)
           FROM orders"""
    ).fetchone()
    rows, bars_ntl, bars_qty = con.execute(
        "SELECT (SELECT count(*) FROM aggd), "
        "(SELECT coalesce(sum(CAST(notional AS HUGEINT)), 0) FROM bar_1m), "
        "(SELECT coalesce(sum(buy_q + sell_q), 0) FROM bar_1m)"
    ).fetchone()
    big_n, big_ntl = con.execute(
        "SELECT count(*), coalesce(sum(CAST(notional AS HUGEINT)), 0) FROM big_order"
    ).fetchone()
    return {
        "rule_version": 1,
        "orders_n": int(n),
        "orders_notional": int(ntl),
        "big_floor_n": big_floor_n,
        "big_orders": int(big_n),
        "big_notional": int(big_ntl),
        "bars_notional": int(bars_ntl),
        # Partition der aggTrades: Σ Notional, Σ Lots und Anzahl aggTrades wie die Bars, keine Order
        # mit verschiedenen T/Seiten oder ID-Lücken (Regelverletzungen)
        "reconciled": int(ntl) == int(bars_ntl)
        and int(qty) == int(bars_qty)
        and int(aggs) == int(rows)
        and int(bad) == 0,
    }


def build_day_tables(
    con: duckdb.DuckDBPyConnection,
    spec: SymbolSpec,
    day_ms: int,
    big_floor_n: int | None = None,
) -> dict:
    """Erzeugt alle Tabellen eines UTC-Tages aus ``agg`` und ``kl`` (Minute nach T, §3.3) samt
    Orders/big_order (§3.7); liefert die Ordersummen (siehe ``build_orders``)."""
    d0, d1 = day_ms, day_ms + MS_DAY
    for t in DIGEST_TABLES:
        con.execute(f"DROP TABLE IF EXISTS {t}")
    con.execute("DROP TABLE IF EXISTS aggd")
    con.execute(
        f"""CREATE TABLE aggd AS
            SELECT id, px, q, f, l, t, m, t - t % {MS_MIN} AS mt
            FROM agg WHERE t >= {d0} AND t < {d1} ORDER BY id"""
    )
    # Basistabelle: je (Minute nach T, Preis); Käufer-Aggressor = m false (§4.4).
    con.execute(
        """CREATE TABLE fp_1m AS
           SELECT mt AS ts, px,
                  CAST(coalesce(sum(q) FILTER (WHERE NOT m), 0) AS BIGINT) AS buy_q,
                  CAST(coalesce(sum(q) FILTER (WHERE m), 0) AS BIGINT) AS sell_q,
                  CAST(count(*) FILTER (WHERE NOT m) AS BIGINT) AS buy_a,
                  CAST(count(*) FILTER (WHERE m) AS BIGINT) AS sell_a
           FROM aggd GROUP BY mt, px"""
    )
    # Rollups: Zeit = Beginn des Zeitfensters, Zeile = floor(px / (bin*tick_ref_units)) * Breite.
    for r in ROLLUPS:
        width = r.bin_ticks * spec.tick_ref_units
        con.execute(
            f"""CREATE TABLE {r.table} AS
                SELECT ts - ts % {r.bucket_ms} AS ts, (px // {width}) * {width} AS px,
                       CAST(sum(buy_q) AS BIGINT) AS buy_q, CAST(sum(sell_q) AS BIGINT) AS sell_q,
                       CAST(sum(buy_a) AS BIGINT) AS buy_a, CAST(sum(sell_a) AS BIGINT) AS sell_a
                FROM fp_1m GROUP BY 1, 2"""
        )
    # bar_1m: Statistik je Minute, geordnet nach aggId (laufendes Delta, COT-Startpunkte).
    con.execute(
        """CREATE TABLE bar_1m AS
        WITH x AS (
            SELECT mt, id, px, q, t, m, CASE WHEN m THEN -q ELSE q END AS d,
                   CAST(sum(CASE WHEN m THEN -q ELSE q END) OVER (PARTITION BY mt ORDER BY id)
                        AS BIGINT) AS cum
            FROM aggd),
        s AS (
            SELECT mt, min(px) AS lo, max(px) AS hi, max(cum) AS rmax, min(cum) AS rmin,
                   arg_max(cum, id) AS tot, arg_min(px, id) AS opx, arg_max(px, id) AS cpx,
                   CAST(sum(q) FILTER (WHERE NOT m) AS BIGINT) AS bq,
                   CAST(sum(q) FILTER (WHERE m) AS BIGINT) AS sq,
                   count(*) FILTER (WHERE NOT m) AS ba, count(*) FILTER (WHERE m) AS sa,
                   CAST(sum(px * q) AS BIGINT) AS ntl, min(id) AS fid, max(id) AS lid,
                   arg_min(t, id) AS ftm, arg_max(t, id) AS ltm
            FROM x GROUP BY mt),
        c AS (
            SELECT x.mt,
                   arg_min(x.cum - x.d, x.id) FILTER (WHERE x.px = s.lo) AS pre_lo,
                   arg_min(x.cum - x.d, x.id) FILTER (WHERE x.px = s.hi) AS pre_hi
            FROM x JOIN s USING (mt) GROUP BY x.mt)
        SELECT s.mt AS ts, s.opx AS open_px, s.hi AS high_px, s.lo AS low_px, s.cpx AS close_px,
               coalesce(s.bq, 0) AS buy_q, coalesce(s.sq, 0) AS sell_q,
               CAST(s.ba AS BIGINT) AS buy_a, CAST(s.sa AS BIGINT) AS sell_a, s.ntl AS notional,
               s.fid AS first_agg_id, s.lid AS last_agg_id, s.ftm AS first_trade_ms,
               s.ltm AS last_trade_ms, s.rmax AS run_max, s.rmin AS run_min,
               s.tot - c.pre_lo AS d_from_low, s.tot - c.pre_hi AS d_from_high,
               3 AS source
        FROM s JOIN c USING (mt)"""
    )
    # bar_1h / bar_1d: Komposition aus den Minutenbars (§3.5), Präfixsumme exklusive.
    for table, width in (("bar_1h", MS_HOUR), ("bar_1d", MS_DAY)):
        con.execute(
            f"""CREATE TABLE {table} AS
            WITH x AS (
                SELECT *, ts - ts % {width} AS b, buy_q - sell_q AS d,
                       sum(buy_q - sell_q) OVER (PARTITION BY ts - ts % {width} ORDER BY ts)
                         - (buy_q - sell_q) AS pex,
                       min(low_px) OVER (PARTITION BY ts - ts % {width}) AS blo,
                       max(high_px) OVER (PARTITION BY ts - ts % {width}) AS bhi
                FROM bar_1m)
            SELECT b AS ts, arg_min(open_px, ts) AS open_px, max(high_px) AS high_px,
                   min(low_px) AS low_px, arg_max(close_px, ts) AS close_px,
                   CAST(sum(buy_q) AS BIGINT) AS buy_q, CAST(sum(sell_q) AS BIGINT) AS sell_q,
                   CAST(sum(buy_a) AS BIGINT) AS buy_a, CAST(sum(sell_a) AS BIGINT) AS sell_a,
                   CAST(sum(notional) AS BIGINT) AS notional,
                   arg_min(first_agg_id, ts) AS first_agg_id, arg_max(last_agg_id, ts) AS last_agg_id,
                   arg_min(first_trade_ms, ts) AS first_trade_ms,
                   arg_max(last_trade_ms, ts) AS last_trade_ms,
                   max(pex + run_max) AS run_max, min(pex + run_min) AS run_min,
                   CAST(arg_min(d_from_low - pex - d, ts) FILTER (WHERE low_px = blo)
                        + sum(d) AS BIGINT) AS d_from_low,
                   CAST(arg_min(d_from_high - pex - d, ts) FILTER (WHERE high_px = bhi)
                        + sum(d) AS BIGINT) AS d_from_high
            FROM x GROUP BY b"""
        )
    con.execute(
        f"""CREATE TABLE kline_1m AS
            SELECT ts, open_px, high_px, low_px, close_px, vol, taker_buy, trades, quote_vol_n
            FROM kl WHERE ts >= {d0} AND ts < {d1}"""
    )
    return build_orders(con, big_floor_n)


def row_text_sql(table: str, sym_id: int) -> str:
    """SQL-Ausdruck für die Postgres-Zeilentextform ROW(sym_id, ts, ...)::text (Migration 0005).

    Zeitstempel (timestamptz, Zeitzone UTC, ISO-Stil) enthalten ein Leerzeichen und stehen daher
    in doppelten Anführungszeichen; Ganzzahlen unquotiert; Felder mit Komma getrennt.
    """
    cols = TABLE_COLS[table]
    parts = [f"'{sym_id}'"]
    for c in cols:
        if c == "ts" and table == "big_order":
            # T der Order in ms: Postgres schreibt den Sekundenbruch ohne abschließende Nullen
            # ("...:05.12+00" für 120 ms) und lässt ihn bei 0 ms ganz weg.
            parts.append(
                "'\"' || strftime(make_timestamp(ts * 1000), '%Y-%m-%d %H:%M:%S') || "
                "CASE WHEN ts % 1000 = 0 THEN '' "
                "ELSE '.' || rtrim(lpad(CAST(ts % 1000 AS VARCHAR), 3, '0'), '0') END || '+00\"'"
            )
        elif c == "ts":
            parts.append(
                "'\"' || strftime(make_timestamp(ts * 1000), '%Y-%m-%d %H:%M:%S') || '+00\"'"
            )
        else:
            parts.append(f"CAST({c} AS VARCHAR)")
    return "'(' || " + " || ',' || ".join(parts) + " || ')'"


def table_digest(con: duckdb.DuckDBPyConnection, table: str, sym_id: int) -> tuple[str, int]:
    """SHA256 über die nach Primärschlüssel sortierten Zeilentexte, mit \\n verbunden."""
    cur = con.execute(
        f"SELECT {row_text_sql(table, sym_id)} FROM {table} ORDER BY {ORDER_BY[table]}"
    )
    h = hashlib.sha256()
    n = 0
    while True:
        rows = cur.fetchmany(200_000)
        if not rows:
            break
        text = "\n".join(r[0] for r in rows)
        h.update((("\n" if n else "") + text).encode("utf-8"))
        n += len(rows)
    return h.hexdigest(), n


def order_day_digest(
    sym_id: int, day: str, orders_n: int, orders_notional: int, big_floor_n: int | None
) -> str:
    """Digest-Teil order_day: die Zeile ROW(sym_id, day, orders_n, orders_notional, big_floor_n)::text
    aus data_day (Datum ISO ohne Anführungszeichen, NULL als leeres Feld)."""
    floor = "" if big_floor_n is None else str(big_floor_n)
    text = f"({sym_id},{day},{orders_n},{orders_notional},{floor})"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def combine_digests(digests: dict[str, str], version: int = DIGEST_VERSION) -> str:
    """day_digest_all_v: SHA256 über 'teil:digest'-Zeilen in der festen Reihenfolge der Version."""
    if version not in DIGEST_PARTS:
        raise ValueError(f"unbekannte Digest-Version {version}")
    text = "\n".join(f"{t}:{digests[t]}" for t in DIGEST_PARTS[version])
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def day_digests(con: duckdb.DuckDBPyConnection, spec: SymbolSpec, day: str, orders: dict) -> dict:
    """Digests je Tabelle, order_day und der kombinierte Digest jeder Version."""
    out: dict[str, dict] = {}
    for t in DIGEST_TABLES:
        digest, n = table_digest(con, t, spec.sym_id)
        out[t] = {"digest": digest, "rows": n}
    out["order_day"] = {
        "digest": order_day_digest(
            spec.sym_id, day, orders["orders_n"], orders["orders_notional"], orders["big_floor_n"]
        ),
        "rows": 1,
    }
    flat = {t: v["digest"] for t, v in out.items()}
    per_version = {str(v): combine_digests(flat, v) for v in DIGEST_PARTS}
    return {
        "tables": out,
        "day_digests": per_version,
        "day_digest": per_version[str(DIGEST_VERSION)],
    }


def range_checks(con: duckdb.DuckDBPyConnection) -> dict:
    """int32-Grenzen der Spalten, die in Postgres als integer geführt werden (§3.4)."""
    over = con.execute(
        f"""SELECT count(*) FROM fp_1m WHERE px > {INT32_MAX} OR buy_q > {INT32_MAX}
            OR sell_q > {INT32_MAX} OR buy_a > {INT32_MAX} OR sell_a > {INT32_MAX}"""
    ).fetchone()[0]
    over_roll = 0
    for r in ROLLUPS:
        over_roll += con.execute(
            f"SELECT count(*) FROM {r.table} WHERE px > {INT32_MAX} OR buy_a > {INT32_MAX} "
            f"OR sell_a > {INT32_MAX}"
        ).fetchone()[0]
    return {"fp_1m_int32_overflow_rows": over, "rollup_int32_overflow_rows": over_roll}
