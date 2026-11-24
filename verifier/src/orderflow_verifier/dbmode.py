"""Datenbankmodus: Neuberechnung (Dateimodus) gegen den Inhalt von PostgreSQL vergleichen.

UNGETESTET gegen eine echte Datenbank: zum Zeitpunkt der Entwicklung gab es keine PostgreSQL-Instanz
(Docker fehlte). Getestet ist nur die Diff-Logik mit einem DuckDB-Ersatz (tests/test_dbmode.py).
Die SQL-Texte gegen Postgres sind sorgfältig gegen die Migrationen 0002–0005 geschrieben, aber nie
ausgeführt worden.

Vorgehen je Tabelle (alle 12 Tabellen aus ``day_digest_all``):
 1. Zeilenzahl und ``day_digest(tabelle, sym, tag)`` des Servers gegen die eigene Berechnung;
 2. bei Abweichung werden die gespeicherten Zeilen des Tages geholt und per FULL JOIN über den
    Primärschlüssel verglichen; gemeldet werden die ersten Differenzzeilen (nur eigene / nur DB /
    abweichende Spalten);
 3. Qualitätstabellen: ``data_day`` (Zustand, Zähler, Digest), ``data_minute_issue``,
    ``bar_1m.check_state``, ``raw_day`` (aggTrades).
Verbindung über OF_DB_HOST, OF_DB_PORT (54320), OF_DB_USER, OF_DB_PASSWORD, OF_DB_NAME (orderflow).
Benötigt ``psycopg`` (requirements-db.txt), das nur hier und nur zur Laufzeit importiert wird.
"""

from __future__ import annotations

import datetime as dt
import os
import tempfile
from pathlib import Path
from typing import Protocol

import duckdb

from . import recompute as rc
from .units import DIGEST_TABLES, SymbolSpec
from .verify import verify_day

STATE_CODE = {"exact": 1, "shift": 2, "mismatch": 3, "edge_pending": 4}  # bar_1m.check_state
KEY_COLS = {t: (["ts", "px"] if t.startswith("fp_") else ["ts"]) for t in DIGEST_TABLES}


class Fetcher(Protocol):
    """Zugriff auf die Datenbank; ``PgFetcher`` gegen Postgres, im Test ein DuckDB-Ersatz."""

    def symbol_row(self, name: str) -> dict | None: ...
    def server_digest(self, table: str, sym_id: int, day: str) -> str: ...
    def server_digest_all(self, sym_id: int, day: str) -> str: ...
    def load_table(
        self, con: duckdb.DuckDBPyConnection, table: str, sym_id: int, day: str, into: str
    ) -> None: ...
    def rows(self, sql: str, params: tuple) -> list[dict]: ...


def stored_select(table: str) -> str:
    """SELECT der gespeicherten Zeilen eines Tages; ts als Epoche in ms (exakt wie im Dateimodus)."""
    cols = ", ".join(
        "(extract(epoch FROM ts) * 1000)::bigint AS ts" if c == "ts" else c
        for c in rc.TABLE_COLS[table]
    )
    order = "ts, px" if table.startswith("fp_") else "ts"
    return (
        f"SELECT {cols} FROM {table} WHERE sym_id = %s "
        "AND ts >= (%s::date::timestamp AT TIME ZONE 'UTC') "
        "AND ts < ((%s::date + 1)::timestamp AT TIME ZONE 'UTC') "
        f"ORDER BY {order}"
    )


class PgFetcher:
    """psycopg-3-Zugriff. Nur lesend; jede Sitzung läuft in einer READ ONLY-Transaktion."""

    def __init__(self) -> None:
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover - hängt von der Umgebung ab
            raise RuntimeError(
                "psycopg fehlt: verifier/.venv/bin/pip install -r verifier/requirements-db.txt"
            ) from exc
        password = os.environ.get("OF_DB_PASSWORD")
        if not password:
            raise RuntimeError(
                "OF_DB_PASSWORD ist nicht gesetzt (Verbindungsdaten nur per Umgebung)"
            )
        self._pg = psycopg
        self.conn = psycopg.connect(
            host=os.environ.get("OF_DB_HOST", "127.0.0.1"),
            port=int(os.environ.get("OF_DB_PORT", "54320")),
            user=os.environ.get("OF_DB_USER", "orderflow"),
            password=password,
            dbname=os.environ.get("OF_DB_NAME", "orderflow"),
            autocommit=False,
        )
        self.conn.read_only = True

    def symbol_row(self, name: str) -> dict | None:
        r = self.rows(
            "SELECT sym_id, price_decimals, qty_decimals, tick_ref_units FROM symbol WHERE name = %s",
            (name,),
        )
        return r[0] if r else None

    def server_digest(self, table: str, sym_id: int, day: str) -> str:
        with self.conn.cursor() as cur:
            cur.execute("SELECT day_digest(%s, %s::smallint, %s::date)", (table, sym_id, day))
            return cur.fetchone()[0]

    def server_digest_all(self, sym_id: int, day: str) -> str:
        with self.conn.cursor() as cur:
            cur.execute("SELECT day_digest_all(%s::smallint, %s::date)", (sym_id, day))
            return cur.fetchone()[0]

    def load_table(
        self, con: duckdb.DuckDBPyConnection, table: str, sym_id: int, day: str, into: str
    ) -> None:
        dt.date.fromisoformat(day)  # nur ein echtes Datum darf in den COPY-Text
        # COPY kennt keine serverseitigen Parameter: ClientCursor.mogrify setzt die Werte ein.
        with self._pg.ClientCursor(self.conn) as client:
            sql = client.mogrify(stored_select(table), (sym_id, day, day))
        with tempfile.NamedTemporaryFile("wb", suffix=".csv", delete=False) as tmp:
            path = tmp.name
            with (
                self.conn.cursor() as cur,
                cur.copy(f"COPY ({sql}) TO STDOUT WITH (FORMAT csv)") as cp,
            ):
                for chunk in cp:
                    tmp.write(bytes(chunk))
        try:
            types = ", ".join(f"'{c}': 'BIGINT'" for c in rc.TABLE_COLS[table])
            con.execute(
                f"CREATE OR REPLACE TABLE {into} AS "
                f"SELECT * FROM read_csv('{path}', header = false, columns = {{{types}}})"
            )
        finally:
            Path(path).unlink(missing_ok=True)

    def rows(self, sql: str, params: tuple) -> list[dict]:
        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            names = [c.name for c in cur.description]
            return [dict(zip(names, r, strict=True)) for r in cur.fetchall()]


def diff_table(con: duckdb.DuckDBPyConnection, table: str, db_table: str, limit: int = 5) -> dict:
    """Vergleicht eigene Tabelle ``table`` mit geladenen DB-Zeilen ``db_table`` (FULL JOIN)."""
    cols = rc.TABLE_COLS[table]
    keys = KEY_COLS[table]
    vals = [c for c in cols if c not in keys]
    on = " AND ".join(f"m.{k} = d.{k}" for k in keys)
    differs = " OR ".join(f"m.{c} IS DISTINCT FROM d.{c}" for c in vals)
    where = f"m.{keys[0]} IS NULL OR d.{keys[0]} IS NULL OR {differs}"
    base = f"FROM {table} m FULL JOIN {db_table} d ON {on} WHERE {where}"
    n = con.execute(f"SELECT count(*) {base}").fetchone()[0]
    sel = ", ".join(
        [f"coalesce(m.{k}, d.{k}) AS {k}" for k in keys]
        + [f"m.{c} AS m_{c}, d.{c} AS d_{c}" for c in vals]
        + [f"m.{keys[0]} IS NULL AS only_db", f"d.{keys[0]} IS NULL AS only_mine"]
    )
    cur = con.execute(
        f"SELECT {sel} {base} ORDER BY {', '.join('coalesce(m.' + k + ', d.' + k + ')' for k in keys)} LIMIT {limit}"
    )
    names = [c[0] for c in cur.description]
    out = []
    for row in cur.fetchall():
        r = dict(zip(names, row, strict=True))
        entry = {k: r[k] for k in keys}
        if r["only_mine"]:
            entry["kind"] = "only_in_recomputation"
            entry["mine"] = {c: r[f"m_{c}"] for c in vals}
        elif r["only_db"]:
            entry["kind"] = "only_in_database"
            entry["db"] = {c: r[f"d_{c}"] for c in vals}
        else:
            entry["kind"] = "column_differences"
            entry["columns"] = {
                c: {"mine": r[f"m_{c}"], "db": r[f"d_{c}"]}
                for c in vals
                if r[f"m_{c}"] != r[f"d_{c}"]
            }
        out.append(entry)
    return {"differing_rows": n, "first": out}


def compare_with_fetcher(
    fx: Fetcher,
    con: duckdb.DuckDBPyConnection,
    spec: SymbolSpec,
    result: dict,
    day: str,
    limit: int = 5,
) -> dict:
    """Kernvergleich zwischen Dateimodus-Ergebnis (``result``, Tabellen in ``con``) und der DB."""
    tables: dict[str, dict] = {}
    for t in DIGEST_TABLES:
        mine = result["tables"][t]
        srv = fx.server_digest(t, spec.sym_id, day)
        entry = {
            "recomputed_rows": mine["rows"],
            "recomputed_digest": mine["digest"],
            "db_digest": srv,
            "equal": srv == mine["digest"],
        }
        if not entry["equal"]:
            into = f"db_{t}"
            fx.load_table(con, t, spec.sym_id, day, into)
            entry["db_rows"] = con.execute(f"SELECT count(*) FROM {into}").fetchone()[0]
            entry.update(diff_table(con, t, into, limit))
        tables[t] = entry
    all_db = fx.server_digest_all(spec.sym_id, day)
    quality = _compare_quality(fx, con, spec, result, day, limit)
    equal = (
        all(v["equal"] for v in tables.values())
        and all_db == result["day_digest"]
        and quality["equal"]
    )
    return {
        "mode": "db",
        "untested_against_real_database": True,
        "symbol": spec.name,
        "sym_id": spec.sym_id,
        "day": day,
        "equal": equal,
        "day_digest": {
            "recomputed": result["day_digest"],
            "db": all_db,
            "equal": all_db == result["day_digest"],
        },
        "tables": tables,
        "quality": quality,
    }


def _compare_quality(
    fx: Fetcher,
    con: duckdb.DuckDBPyConnection,
    spec: SymbolSpec,
    result: dict,
    day: str,
    limit: int,
) -> dict:
    cls = result["classification"]
    out: dict = {"checks": {}}

    def check(name: str, mine, db) -> None:
        out["checks"][name] = {"recomputed": mine, "db": db, "equal": mine == db}

    dd = fx.rows("SELECT * FROM data_day WHERE sym_id = %s AND day = %s::date", (spec.sym_id, day))
    if not dd:
        out["data_day"] = "keine Zeile"
        out["equal"] = False
        return out
    row = dd[0]
    counts = cls["counts"]
    check("state", result["state"], row["state"])
    check("digest", result["day_digest"], row["digest"])
    check("rows", result["manifest"]["rows"], row["rows"])
    check("first_agg_id", result["manifest"]["first_agg_id"], row["first_agg_id"])
    check("last_agg_id", result["manifest"]["last_agg_id"], row["last_agg_id"])
    check("min_exact", counts["exact"], row["min_exact"])
    check("min_shift", counts["shift"], row["min_shift"])
    check("min_mismatch", counts["mismatch"], row["min_mismatch"])
    check("min_missing", counts["missing"], row["min_missing"])
    check("edge_pending", counts["edge_pending"] > 0, row["edge_pending"])

    # data_minute_issue: Art und Beträge je Minute (Übertrag: begrenzt oder roh akzeptiert)
    issues = fx.rows(
        "SELECT (extract(epoch FROM ts) * 1000)::bigint AS ts, kind, d_q, d_b, cand_q, cand_b, "
        "carry_q, carry_b FROM data_minute_issue WHERE sym_id = %s "
        "AND ts >= (%s::date::timestamp AT TIME ZONE 'UTC') "
        "AND ts < ((%s::date + 1)::timestamp AT TIME ZONE 'UTC') ORDER BY ts, kind",
        (spec.sym_id, day, day),
    )
    mine_issues = [m for m in cls["minutes"] if m["class"] in ("shift", "mismatch", "missing")]
    got = {(int(r["ts"]), r["kind"]): r for r in issues}
    want = {(m["ts"], m["class"]): m for m in mine_issues}
    diffs = []
    for k in sorted(set(got) | set(want)):
        if k not in got:
            diffs.append({"ts": k[0], "kind": k[1], "problem": "fehlt in DB"})
        elif k not in want:
            diffs.append({"ts": k[0], "kind": k[1], "problem": "nur in DB"})
        else:
            g, w = got[k], want[k]
            same = (g["d_q"], g["d_b"], g["cand_q"], g["cand_b"]) == (
                w["d_q"],
                w["d_b"],
                w["cand_q"],
                w["cand_b"],
            ) and (
                (g["carry_q"], g["carry_b"])
                in ((w["carry_q"], w["carry_b"]), (w["carry_raw_q"], w["carry_raw_b"]))
            )
            if not same:
                diffs.append(
                    {"ts": k[0], "kind": k[1], "problem": "Beträge", "db": dict(g), "mine": w}
                )
    out["data_minute_issue"] = {"differences": len(diffs), "first": diffs[:limit]}

    # bar_1m.check_state gegen die eigene Klasse (fehlende Minuten haben keine Bar-Zeile)
    cs = fx.rows(
        "SELECT (extract(epoch FROM ts) * 1000)::bigint AS ts, check_state FROM bar_1m "
        "WHERE sym_id = %s AND ts >= (%s::date::timestamp AT TIME ZONE 'UTC') "
        "AND ts < ((%s::date + 1)::timestamp AT TIME ZONE 'UTC') ORDER BY ts",
        (spec.sym_id, day, day),
    )
    bad_state = []
    cls_by_ts = {m["ts"]: m["class"] for m in cls["minutes"]}
    for r in cs:
        mine_c = cls_by_ts.get(int(r["ts"]), "exact")
        want_code = STATE_CODE.get(mine_c)
        if want_code is not None and r["check_state"] != want_code:
            bad_state.append({"ts": int(r["ts"]), "db": r["check_state"], "mine_class": mine_c})
    out["bar_1m_check_state"] = {"differences": len(bad_state), "first": bad_state[:limit]}

    rd = fx.rows(
        "SELECT rows, first_agg_id, last_agg_id, agg_id_holes, agg_id_dups, ts_backwards, "
        "continues_prev FROM raw_day WHERE sym_id = %s AND kind = 'aggTrades' AND day = %s::date",
        (spec.sym_id, day),
    )
    man = result["manifest"]
    if rd:
        r0 = rd[0]
        for k in (
            "rows",
            "first_agg_id",
            "last_agg_id",
            "agg_id_holes",
            "agg_id_dups",
            "ts_backwards",
            "continues_prev",
        ):
            check(f"raw_day.{k}", man[k], r0[k])
    else:
        out["raw_day"] = "keine Zeile"
    out["equal"] = (
        all(c["equal"] for c in out["checks"].values())
        and not diffs
        and not bad_state
        and "raw_day" not in out
    )
    return out


def compare_db(
    root: Path,
    sym: SymbolSpec,
    day: str,
    *,
    prefer: str = "auto",
    lookback: int = 2,
    work_dir: Path | None = None,
    limit: int = 5,
    fetcher: Fetcher | None = None,
) -> dict:
    fx = fetcher or PgFetcher()
    row = fx.symbol_row(sym.name)
    if row is None:
        raise ValueError(f"Symbol {sym.name} fehlt in der Tabelle symbol")
    notes = []
    if (row["price_decimals"], row["qty_decimals"], row["tick_ref_units"]) != (
        sym.price_decimals,
        sym.qty_decimals,
        sym.tick_ref_units,
    ):
        notes.append(f"symbol-Parameter weichen ab: DB={row}, Verifier={sym}")
    spec = SymbolSpec(
        sym.name,
        int(row["sym_id"]),
        int(row["price_decimals"]),
        int(row["qty_decimals"]),
        int(row["tick_ref_units"]),
    )
    result, con = verify_day(
        root, spec, day, prefer=prefer, lookback=lookback, work_dir=work_dir, checksums=False
    )
    out = compare_with_fetcher(fx, con, spec, result, day, limit)
    out["notes"] = notes
    out["recomputation"] = {
        "state": result["state"],
        "classification_counts": result["classification"]["counts"],
        "perf": result["perf"],
    }
    return out


def db_summary(r: dict) -> str:
    lines = [
        f"DB-Vergleich {r['symbol']} {r['day']} (UNGETESTET gegen echte DB): "
        f"{'GLEICH' if r['equal'] else 'ABWEICHUNG'}",
        f"  Tages-Digest eigen={r['day_digest']['recomputed']} db={r['day_digest']['db']}",
    ]
    for t, v in r["tables"].items():
        mark = "ok " if v["equal"] else "DIFF"
        extra = (
            "" if v["equal"] else f" db_rows={v.get('db_rows')} differing={v.get('differing_rows')}"
        )
        lines.append(f"  {mark} {t:12s} rows={v['recomputed_rows']:>9,}{extra}")
        for e in v.get("first", [])[:3]:
            lines.append(f"       {e}")
    q = r["quality"]
    lines.append(f"  quality equal={q['equal']}")
    for k, c in q.get("checks", {}).items():
        if not c["equal"]:
            lines.append(f"       {k}: eigen={c['recomputed']} db={c['db']}")
    return "\n".join(lines)


__all__ = ["PgFetcher", "compare_db", "compare_with_fetcher", "db_summary", "diff_table"]
