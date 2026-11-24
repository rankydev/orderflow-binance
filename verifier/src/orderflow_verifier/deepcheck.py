"""Tiefenprüfung gegen den trades-Dump (KONZEPT §4.7).

Der Dump enthält die Einzelfills mit eigener Fill-Zeit. Schritte:
 2. Vollständigkeit der Referenz (je aggTrade: Fills in [f, l] ergeben Menge, Preis, Seite; je Stunde
    Σ Menge Dump = Σ Menge Kline) -> Stunden ohne Vollständigkeit sind "Referenz unbrauchbar";
 3. in brauchbaren Stunden: Einzelfills nach eigener Zeit je Minute = Kline (Volumen, Taker-Buy, Anzahl);
 4. verschobene Menge s(m) exakt aus den Fill-Zeiten: D(m) = s(m) - s(m-1) und Klasse shift;
 5. Level-Summen je (T-Minute des Eltern-aggTrades, Preis, Seite) = fp_1m.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import duckdb

from . import files as fl
from .units import MS_DAY, MS_HOUR, MS_MIN, SymbolSpec


def _usable_minute(m: int, hours_ok: set[int], last_next_ok: bool) -> bool:
    need = {m // 60}
    if m > 0:
        need.add((m - 1) // 60)
    if m < 1439:
        need.add((m + 1) // 60)
    elif not last_next_ok:
        return False
    return need <= hours_ok


def deep_check(
    con: duckdb.DuckDBPyConnection,
    root: Path,
    sym: SymbolSpec,
    day: str,
    prefer: str = "auto",
    minute_classes: list[dict] | None = None,
    examples: int = 5,
) -> dict:
    d = dt.date.fromisoformat(day)
    d0 = fl.day_to_ms(d)
    d1 = d0 + MS_DAY
    rf = fl.locate(root, "trades", sym.name, d)
    if rf is None:
        return {"deep_check": None, "reason": "kein trades-Dump für diesen Tag"}
    con.execute("DROP TABLE IF EXISTS tr")
    info = fl.load_trades(con, sym, rf)
    nxt = fl.locate(root, "trades", sym.name, fl.add_days(d, 1))
    next_loaded = False
    if nxt is not None:
        # nur die ersten Minuten des Folgetags (Fills von Straddlern des letzten aggTrades)
        fl.load_trades(con, sym, nxt, t_to=d1 + MS_MIN)
        next_loaded = True
    tmin, tmax, ntr = con.execute("SELECT min(id), max(id), count(*) FROM tr").fetchone()

    # Eltern-aggTrade je Fill: größter aggTrade mit f <= id; gültig, wenn id <= l.
    con.execute("DROP TABLE IF EXISTS tr_par")
    con.execute(
        f"""CREATE TABLE tr_par AS
        SELECT tr.id, tr.px, tr.q, tr.t, tr.m, a.id AS aid, a.px AS apx, a.q AS aq, a.m AS am,
               a.l AS al, a.t - a.t % {MS_MIN} AS pmin, tr.t - tr.t % {MS_MIN} AS fmin
        FROM tr ASOF LEFT JOIN agg a ON tr.id >= a.f"""
    )
    orphans = con.execute(
        "SELECT count(*), coalesce(sum(q), 0) FROM tr_par WHERE aid IS NULL OR id > al"
    ).fetchone()
    con.execute("DELETE FROM tr_par WHERE aid IS NULL OR id > al")

    # Schritt 2a: Vollständigkeit je aggTrade des Tages
    con.execute("DROP TABLE IF EXISTS agg_chk")
    con.execute("DROP TABLE IF EXISTS lvl_diff")
    con.execute(
        f"""CREATE TABLE agg_chk AS
        SELECT a.id, a.f, a.l, a.q, a.t, (a.t - {d0}) // {MS_HOUR} AS h,
               coalesce(s.n, 0) AS n, coalesce(s.sq, 0) AS sq, coalesce(s.bad, 0) AS bad,
               (a.f >= {tmin} AND a.l <= {tmax}) AS checkable
        FROM aggd a LEFT JOIN (
            SELECT aid, count(*) AS n, sum(q) AS sq,
                   count(*) FILTER (WHERE px <> apx OR m <> am) AS bad
            FROM tr_par GROUP BY aid) s ON s.aid = a.id"""
    )
    hourly = con.execute(
        """SELECT h, count(*) AS aggs,
                  count(*) FILTER (WHERE NOT checkable) AS unchecked,
                  count(*) FILTER (WHERE checkable AND (sq <> q OR bad > 0)) AS bad_aggs,
                  coalesce(sum((l - f + 1) - n) FILTER (WHERE checkable), 0) AS missing_ids,
                  coalesce(sum((l - f + 1) - n) FILTER (WHERE checkable AND (sq <> q OR bad > 0)),
                           0) AS missing_ids_in_bad_aggs,
                  count(*) FILTER (WHERE checkable AND n = 0) AS aggs_without_fills
           FROM agg_chk GROUP BY h ORDER BY h"""
    ).fetchall()
    dump_h = dict(
        con.execute(
            f"SELECT (t - {d0}) // {MS_HOUR}, sum(q) FROM tr WHERE t >= {d0} AND t < {d1} GROUP BY 1"
        ).fetchall()
    )
    kl_h = dict(
        con.execute(
            f"SELECT (ts - {d0}) // {MS_HOUR}, sum(vol) FROM kl WHERE ts >= {d0} AND ts < {d1} GROUP BY 1"
        ).fetchall()
    )
    hours = []
    usable: set[int] = set()
    for h in range(24):
        row = next((r for r in hourly if r[0] == h), (h, 0, 0, 0, 0, 0, 0))
        dq, kq = int(dump_h.get(h, 0)), int(kl_h.get(h, 0))
        ok = row[3] == 0 and dq == kq
        if ok:
            usable.add(h)
        hours.append(
            {
                "hour": h,
                "aggtrades": row[1],
                "unchecked_aggtrades": row[2],
                "aggtrades_with_incomplete_fills": row[3],
                "aggtrades_without_any_fill": row[6],
                "missing_trade_ids": int(row[4]),
                "missing_trade_ids_in_incomplete_aggs": int(row[5]),
                "dump_qty": dq,
                "kline_qty": kq,
                "qty_equal": dq == kq,
                "usable": ok,
            }
        )

    # Schritt 3: Fills nach eigener Zeit je Minute = Kline (Volumen, Taker-Buy, Anzahl)
    rows3 = con.execute(
        f"""WITH o AS (SELECT t - t % {MS_MIN} AS mt, sum(q) AS q, sum(q) FILTER (WHERE NOT m) AS b, count(*) AS n
                  FROM tr WHERE t >= {d0} AND t < {d1} GROUP BY 1)
        SELECT i AS m, coalesce(k.vol, 0), coalesce(k.taker_buy, 0), coalesce(k.trades, 0),
               coalesce(o.q, 0), coalesce(o.b, 0), coalesce(o.n, 0)
        FROM range(1440) r(i)
        LEFT JOIN kl k ON k.ts = {d0} + {MS_MIN} * i
        LEFT JOIN o ON o.mt = {d0} + {MS_MIN} * i ORDER BY i"""
    ).fetchall()
    step3_bad = []
    step3_n = 0
    for m, kv, kb, kn, ov, ob, on in rows3:
        if (m // 60) not in usable:
            continue
        step3_n += 1
        if (kv, kb, kn) != (int(ov), int(ob), int(on)):
            step3_bad.append(
                {"minute": m, "kline": [kv, kb, kn], "dump": [int(ov), int(ob), int(on)]}
            )

    # Schritt 4: verschobene Menge exakt aus Fill-Zeiten
    shift = {
        r[0]: (int(r[1]), int(r[2]))
        for r in con.execute(
            f"""SELECT (pmin - {d0}) // {MS_MIN}, sum(q), coalesce(sum(q) FILTER (WHERE NOT m), 0)
                FROM tr_par WHERE pmin <> fmin AND pmin >= {d0 - MS_MIN} AND pmin < {d1}
                GROUP BY 1"""
        ).fetchall()
    }
    far = con.execute("SELECT count(*) FROM tr_par WHERE fmin - pmin NOT IN (0, 60000)").fetchone()[
        0
    ]
    straddlers = con.execute(
        f"""SELECT count(DISTINCT p.aid), count(DISTINCT p.aid) FILTER (
                WHERE NOT (a.l > a.f AND a.t % {MS_MIN} >= 59900))
            FROM tr_par p JOIN agg a ON a.id = p.aid
            WHERE p.pmin <> p.fmin AND p.pmin >= {d0} AND p.pmin < {d1}"""
    ).fetchone()
    ours = {
        r[0]: (int(r[1]), int(r[2]))
        for r in con.execute(
            f"SELECT (ts - {d0}) // {MS_MIN}, buy_q + sell_q, buy_q FROM bar_1m"
        ).fetchall()
    }
    kline = {
        r[0]: (int(r[1]), int(r[2]))
        for r in con.execute(
            f"SELECT (ts - {d0}) // {MS_MIN}, vol, taker_buy FROM kl WHERE ts >= {d0} AND ts < {d1}"
        ).fetchall()
    }
    cls = {r["minute"]: r["class"] for r in (minute_classes or [])}
    step4_bad, class_bad = [], []
    step4_n = carry_checked = 0
    for m in range(1440):
        if not _usable_minute(m, usable, next_loaded):
            continue
        step4_n += 1
        o = ours.get(m, (0, 0))
        k = kline.get(m, (0, 0))
        s_m = shift.get(m, (0, 0))
        s_p = shift.get(m - 1, (0, 0))
        d_q, d_b = o[0] - k[0], o[1] - k[1]
        if d_q != s_m[0] - s_p[0] or d_b != s_m[1] - s_p[1]:
            step4_bad.append({"minute": m, "D": [d_q, d_b], "s": list(s_m), "s_prev": list(s_p)})
        if minute_classes is not None:
            expect = "exact" if (d_q == 0 and d_b == 0 and s_m == (0, 0)) else "shift"
            got = cls.get(m, "exact")
            carry_checked += 1
            if got != expect:
                class_bad.append({"minute": m, "expected": expect, "classified": got})

    # Schritt 5: Level-Summen je (T-Minute des Eltern-aggTrades, Preis, Seite) = fp_1m
    usable_sql = ",".join(map(str, sorted(usable))) or "-1"
    con.execute(
        f"""CREATE TABLE lvl_diff AS
        WITH okagg AS (SELECT id FROM agg_chk WHERE checkable AND sq = q AND bad = 0),
            badmin AS (SELECT DISTINCT t - t % {MS_MIN} AS mt FROM agg_chk
                       WHERE NOT (checkable AND sq = q AND bad = 0)),
            d AS (SELECT p.pmin AS ts, p.px,
                         coalesce(sum(p.q) FILTER (WHERE NOT p.m), 0) AS bq,
                         coalesce(sum(p.q) FILTER (WHERE p.m), 0) AS sq
                  FROM tr_par p
                  WHERE p.aid IN (SELECT id FROM okagg)
                    AND ((p.pmin - {d0}) // {MS_HOUR}) IN ({usable_sql})
                    AND p.pmin NOT IN (SELECT mt FROM badmin)
                  GROUP BY 1, 2),
            f AS (SELECT ts, px, buy_q AS bq, sell_q AS sq FROM fp_1m
                  WHERE ts NOT IN (SELECT mt FROM badmin)
                    AND ((ts - {d0}) // {MS_HOUR}) IN ({usable_sql}))
        SELECT coalesce(d.ts, f.ts) AS ts, coalesce(d.px, f.px) AS px,
               d.bq AS d_bq, d.sq AS d_sq, f.bq AS f_bq, f.sq AS f_sq
        FROM d FULL JOIN f ON d.ts = f.ts AND d.px = f.px
        WHERE d.ts IS NULL OR f.ts IS NULL OR d.bq <> f.bq OR d.sq <> f.sq"""
    )
    lvl_bad = con.execute("SELECT count(*) FROM lvl_diff").fetchone()[0]
    lvl = con.execute(f"SELECT * FROM lvl_diff ORDER BY ts, px LIMIT {examples}").fetchall()
    con.execute("DROP TABLE lvl_diff")
    lvl_n = con.execute(
        f"SELECT count(*) FROM fp_1m WHERE ((ts - {d0}) // {MS_HOUR}) IN ({usable_sql})"
    ).fetchone()[0]

    failures = {
        "step3_kline_equality": len(step3_bad),
        "step4_shift_identity": len(step4_bad),
        "step4_class_mismatch": len(class_bad),
        "step4_multi_minute_fills": far,
        "step4_straddlers_not_candidates": straddlers[1],
        "step5_level_sums": lvl_bad,
    }
    if sum(failures.values()) > 0:
        status = "failed"
    elif len(usable) < 24:
        status = "reference_unusable"
    else:
        status = "passed"
    return {
        "deep_check": status,
        "dump": {
            "path": info["path"],
            "header_present": info["header_present"],
            "rows": ntr,
            "next_day_dump_clip_loaded": next_loaded,
            "orphan_fills": {"rows": orphans[0], "qty": int(orphans[1])},
        },
        "usable_hours": sorted(usable),
        "unusable_hours": [h for h in range(24) if h not in usable],
        "usable_hours_result": "failed" if sum(failures.values()) else "passed",
        "hours": hours,
        "straddling_aggtrades": straddlers[0],
        "shifted_minutes": sum(1 for v in shift.values() if v != (0, 0)),
        "step3": {"minutes_checked": step3_n, "mismatches": step3_bad[:examples]},
        "step4": {
            "minutes_checked": step4_n,
            "mismatches": step4_bad[:examples],
            "class_mismatches": class_bad[:examples],
            "class_checked": carry_checked,
            "minute_1439_checked": _usable_minute(1439, usable, next_loaded),
        },
        "step5": {
            "fp_1m_rows_in_usable_hours": lvl_n,
            "level_mismatches": lvl_bad,
            "examples": [list(r) for r in lvl],
        },
        "failures": failures,
    }


def deep_check_standalone(
    root: Path, sym: SymbolSpec, day: str, prefer: str = "auto", work_dir: Path | None = None
) -> dict:
    from .verify import verify_day

    res, con = verify_day(root, sym, day, prefer=prefer, work_dir=work_dir, checksums=False)
    out = deep_check(con, root, sym, day, prefer, res["classification"]["minutes"])
    out.update({"symbol": sym.name, "day": day, "mode": "deep"})
    return out


def deep_summary(r: dict) -> str:
    if r.get("deep_check") is None:
        return f"deep: {r.get('reason')}"
    lines = [
        f"deep check: {r['deep_check']} (usable hours {len(r['usable_hours'])}/24; "
        f"result on usable hours: {r['usable_hours_result']})"
    ]
    if r["unusable_hours"]:
        bad = [h for h in r["hours"] if not h["usable"]]
        lines.append(
            "  unusable hours: "
            + ", ".join(
                f"{h['hour']:02d}(bad_aggs={h['aggtrades_with_incomplete_fills']},"
                f"qty {h['dump_qty']}/{h['kline_qty']})"
                for h in bad
            )
        )
    lines.append(
        f"  step3 minutes={r['step3']['minutes_checked']} mismatches={r['failures']['step3_kline_equality']}"
        f" | step4 minutes={r['step4']['minutes_checked']} identity_fail={r['failures']['step4_shift_identity']}"
        f" class_fail={r['failures']['step4_class_mismatch']} straddling_aggs={r['straddling_aggtrades']}"
        f" | step5 level_mismatches={r['failures']['step5_level_sums']}"
    )
    lines.append(f"  orphan fills (no aggTrade): {r['dump']['orphan_fills']}")
    return "\n".join(lines)
