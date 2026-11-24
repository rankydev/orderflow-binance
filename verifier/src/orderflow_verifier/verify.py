"""Dateimodus: ein Symbol-Tag vollständig aus den Rohdateien neu berechnen (KONZEPT §4.8).

Ergebnis (JSON-fähig): Manifestkennzahlen, Digests je Tabelle und kombiniert, Minutenklassifikation,
Tagessummen, OHLC-Bericht, Laufzeit/Speicher. Die DuckDB-Verbindung mit allen Tagestabellen bleibt
für Tiefenprüfung und Datenbankvergleich erhalten.
"""

from __future__ import annotations

import datetime as dt
import resource
import sys
import time
from pathlib import Path

import duckdb

from . import classify as cl
from . import files as fl
from . import recompute as rc
from .units import MS_DAY, MS_MIN, SymbolSpec, lots_to_str

TOOL_VERSION = "orderflow-verifier@0.1.0"


def peak_rss_mb() -> float:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(r / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def connect(work_dir: Path | None = None, threads: int | None = None) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(":memory:")
    if work_dir is not None:
        work_dir.mkdir(parents=True, exist_ok=True)
        con.execute(f"SET temp_directory = '{work_dir}'")
    if threads:
        con.execute(f"SET threads = {int(threads)}")
    return con


def _manifest_stats(con: duckdb.DuckDBPyConnection, d0: int) -> dict:
    d1 = d0 + MS_DAY
    rows, distinct, lo, hi, tmin, tmax = con.execute(
        "SELECT count(*), count(DISTINCT id), min(id), max(id), min(t), max(t) FROM aggd"
    ).fetchone()
    backwards = con.execute(
        "SELECT count(*) FROM (SELECT t, lag(t) OVER (ORDER BY id) AS pt FROM aggd) WHERE t < pt"
    ).fetchone()[0]
    prev_last = con.execute(
        f"SELECT max(id) FROM agg WHERE t >= {d0 - MS_DAY} AND t < {d0}"
    ).fetchone()[0]
    outside = con.execute(
        f"SELECT count(*) FROM agg WHERE src = (SELECT CAST(strftime(make_timestamp({d0} * 1000), "
        f"'%Y-%m-%d') AS VARCHAR)) AND (t < {d0} OR t >= {d1})"
    ).fetchone()[0]
    return {
        "rows": rows,
        "first_agg_id": lo,
        "last_agg_id": hi,
        "agg_id_holes": (hi - lo + 1 - distinct) if rows else 0,
        "agg_id_dups": rows - distinct,
        "ts_backwards": backwards,
        "continues_prev": (lo == prev_last + 1) if prev_last is not None and rows else None,
        "first_ts": tmin,
        "last_ts": tmax,
        "rows_outside_day_in_daily_file": outside,
    }


def class_row(r: cl.MinuteResult, day_ms: int) -> dict:
    return {
        "minute": r.m,
        "ts": day_ms + r.m * MS_MIN,
        "class": r.cls,
        "own_class": r.own_cls,
        "class_q": r.cls_q,
        "class_b": r.cls_b,
        "d_q": r.d_q,
        "d_b": r.d_b,
        "cand_q": r.cand_q,
        "cand_b": r.cand_b,
        "carry_q": r.s_q,
        "carry_b": r.s_b,
        "carry_raw_q": r.raw_s_q,
        "carry_raw_b": r.raw_s_b,
    }


def verify_day(
    root: Path,
    sym: SymbolSpec,
    day: str,
    *,
    prefer: str = "auto",
    lookback: int = 2,
    work_dir: Path | None = None,
    threads: int | None = None,
    checksums: bool = True,
    all_minutes: bool = False,
) -> tuple[dict, duckdb.DuckDBPyConnection]:
    t_start = time.perf_counter()
    d = dt.date.fromisoformat(day)
    d0 = fl.day_to_ms(d)
    con = connect(work_dir, threads)

    def avail(x: dt.date) -> bool:
        return (
            fl.locate(root, "aggTrades", sym.name, x, prefer) is not None
            and fl.locate(root, "klines", sym.name, x) is not None
        )

    prev_days: list[dt.date] = []
    for k in range(1, lookback + 1):
        x = fl.add_days(d, -k)
        if not avail(x):
            break
        prev_days.append(x)
    prev_days.reverse()
    prev_available = avail(fl.add_days(d, -1))
    nxt = fl.add_days(d, 1)
    next_available = avail(nxt)
    if not avail(d):
        raise FileNotFoundError(f"{sym.name} {day}: aggTrades oder Klines fehlen")

    t0 = time.perf_counter()
    load_days = [*prev_days, d] + ([nxt] if next_available else [])
    clip = {nxt: (d0 + MS_DAY, d0 + MS_DAY + MS_MIN)} if next_available else None
    src_info = fl.load_aggtrades_days(con, sym, root, load_days, prefer, clip)
    for x in load_days:
        fl.load_klines(con, sym, fl.locate(root, "klines", sym.name, x))
    t_load = time.perf_counter() - t0

    # Übertragskette über die Vortage (Start mit s = 0; ein mismatch klemmt den Übertrag, sodass
    # sich ein falscher Startwert nach dem ersten Fehler selbst heilt, siehe README/Bericht).
    carry, cand_prev = (0, 0), (0, 0)
    for x in prev_days:
        dcx = cl.classify_day(cl.minute_inputs(con, fl.day_to_ms(x)), carry, cand_prev, True, True)
        carry, cand_prev = dcx.carry_out, dcx.cand_last
    mins = cl.minute_inputs(con, d0)
    dc = cl.classify_day(mins, carry, cand_prev, prev_available, next_available)
    next_minute0 = None
    if next_available:
        nm = cl.minute_inputs(con, d0 + MS_DAY)[:1]
        n0 = cl.classify_day(nm, dc.carry_out, dc.cand_last, True, True).minutes[0]
        next_minute0 = {
            "class": n0.cls,
            "d_q": n0.d_q,
            "d_b": n0.d_b,
            "cand_q": n0.cand_q,
            "cand_b": n0.cand_b,
            "carry_q": n0.s_q,
            "carry_b": n0.s_b,
        }

    t0 = time.perf_counter()
    rc.build_day_tables(con, sym, d0)
    digests = rc.day_digests(con, sym)
    t_build = time.perf_counter() - t0

    day_tot = cl.totals(mins, dc, cand_prev)
    candidates = con.execute(
        "SELECT count(*) FROM aggd WHERE l > f AND t % 60000 >= 59900"
    ).fetchone()[0]
    exact_q = sum(1 for m in mins if m.ours_q == m.kl_q)
    exact_b = sum(1 for m in mins if m.ours_b == m.kl_b)
    nonexact = [r for r in dc.minutes if all_minutes or r.cls != "exact"]
    counts = {
        k: dc.counts.get(k, 0) for k in ("exact", "shift", "mismatch", "missing", "edge_pending")
    }
    has_bad = counts["mismatch"] > 0 or counts["missing"] > 0

    manifest = _manifest_stats(con, d0)
    manifest["origin"] = src_info[d]["origin"]
    manifest["path"] = src_info[d]["path"]
    manifest["header_present"] = src_info[d]["header_present"]
    if checksums:
        manifest["checksum"] = fl.checksum_status(Path(src_info[d]["path"]))
        manifest["klines_checksum"] = fl.checksum_status(
            fl.locate(root, "klines", sym.name, d).path
        )

    edges = [
        class_row(dc.minutes[0], d0),
        class_row(dc.minutes[-1], d0),
    ]
    result = {
        "tool": TOOL_VERSION,
        "mode": "file",
        "symbol": sym.name,
        "sym_id": sym.sym_id,
        "day": day,
        "state": "final_bad" if has_bad else "final_ok",
        "manifest": manifest,
        "tables": digests["tables"],
        "day_digest": digests["day_digest"],
        "range_checks": rc.range_checks(con),
        "classification": {
            "counts": counts,
            "exact_volume_minutes": exact_q,
            "exact_taker_buy_minutes": exact_b,
            "candidate_aggtrades": candidates,
            "carry_in": {"q": dc.carry_in[0], "b": dc.carry_in[1]},
            "carry_out": {"q": dc.carry_out[0], "b": dc.carry_out[1]},
            "carry_chain_days": [x.isoformat() for x in prev_days],
            "prev_day_available": prev_available,
            "next_day_available": next_available,
            "next_day_minute0": next_minute0,
            "edges": edges,
            "minutes": [class_row(r, d0) for r in nonexact],
        },
        "totals": day_tot,
        "totals_display": {
            k: {
                "ours": lots_to_str(day_tot[k]["ours"], 3),
                "kline": lots_to_str(day_tot[k]["kline"], 3),
                "diff": lots_to_str(day_tot[k]["diff"], 3),
            }
            for k in ("q", "b")
        },
        "ohlc": cl.ohlc_report(mins),
        "perf": {
            "load_s": round(t_load, 2),
            "build_digest_s": round(t_build, 2),
            "total_s": round(time.perf_counter() - t_start, 2),
            "peak_rss_mb": peak_rss_mb(),
        },
    }
    return result, con
