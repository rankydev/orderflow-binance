"""Mengenbasierte Neuberechnung eines Symbol-Tages in DuckDB (KONZEPT §3.3–§3.6, §4.8).

Eingabe: Tabelle ``agg`` (exakt geparste aggTrades, auch Nachbartage) und ``kl`` (Klines).
Ausgabe: Tabellen fp_1m, alle Rollups, bar_1m/1h/1d, kline_1m mit denselben Spalten wie die
Postgres-Tabellen (ts in ms seit Epoche), plus Digests in der Textform der SQL-Funktion day_digest.
"""

from __future__ import annotations

import hashlib

import duckdb

from .units import (
    DIGEST_TABLES,
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

# Spalten je Tabelle in der Reihenfolge von day_digest (Migration 0005), ohne sym_id.
TABLE_COLS: dict[str, list[str]] = {
    **{t: list(FP_COLS) for t in DIGEST_TABLES if t.startswith("fp_")},
    "bar_1m": [*BAR_COLS, "source"],
    "bar_1h": list(BAR_COLS),
    "bar_1d": list(BAR_COLS),
    "kline_1m": KLINE_COLS,
}
ORDER_BY = {t: ("ts, px" if t.startswith("fp_") else "ts") for t in DIGEST_TABLES}


def build_day_tables(con: duckdb.DuckDBPyConnection, spec: SymbolSpec, day_ms: int) -> None:
    """Erzeugt alle Tabellen eines UTC-Tages aus ``agg`` und ``kl`` (Minute nach T, §3.3)."""
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


def row_text_sql(table: str, sym_id: int) -> str:
    """SQL-Ausdruck für die Postgres-Zeilentextform ROW(sym_id, ts, ...)::text (Migration 0005).

    Zeitstempel (timestamptz, Zeitzone UTC, ISO-Stil) enthalten ein Leerzeichen und stehen daher
    in doppelten Anführungszeichen; Ganzzahlen unquotiert; Felder mit Komma getrennt.
    """
    cols = TABLE_COLS[table]
    parts = [f"'{sym_id}'"]
    for c in cols:
        if c == "ts":
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


def combine_digests(digests: dict[str, str]) -> str:
    """day_digest_all: SHA256 über 'tabelle:digest'-Zeilen in der festen Tabellenreihenfolge."""
    text = "\n".join(f"{t}:{digests[t]}" for t in DIGEST_TABLES)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def day_digests(con: duckdb.DuckDBPyConnection, spec: SymbolSpec) -> dict:
    out: dict[str, dict] = {}
    for t in DIGEST_TABLES:
        digest, n = table_digest(con, t, spec.sym_id)
        out[t] = {"digest": digest, "rows": n}
    return {
        "tables": out,
        "day_digest": combine_digests({t: out[t]["digest"] for t in DIGEST_TABLES}),
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
