"""Minutenabgleich gegen die Klines (KONZEPT §4.6): Klassen exact/shift/mismatch/missing/edge_pending.

Die schweren Summen je Minute kommen mengenbasiert aus DuckDB (``minute_inputs``); die Klassifikation
selbst ist ein sequentieller Zustandsautomat über die 1 440 Minuten (der Übertrag s(m) wird bei
einem mismatch auf [0, cand(m)] begrenzt, das ist keine reine Fenstersumme) und läuft deshalb in
Python mit exakten Ganzzahlen.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import duckdb

from .units import MS_DAY, MS_MIN

CAND_FROM_MS_OF_MINUTE = 59_900  # T mod 60 000 >= 59 900 (§4.6)


@dataclass
class MinuteInput:
    m: int
    ours_q: int = 0
    ours_b: int = 0
    ours_present: bool = False
    kl_q: int = 0
    kl_b: int = 0
    kl_present: bool = False
    cand_q: int = 0
    cand_b: int = 0
    # OHLC (None, wenn nicht vorhanden)
    ours_ohlc: tuple | None = None
    kl_ohlc: tuple | None = None


@dataclass
class MinuteResult:
    m: int
    cls: str  # exact | shift | mismatch | missing | edge_pending
    own_cls: str
    d_q: int
    d_b: int
    cand_q: int
    cand_b: int
    s_q: int  # Übertrag nach Begrenzung
    s_b: int
    raw_s_q: int
    raw_s_b: int
    cls_q: str
    cls_b: str


@dataclass
class DayClassification:
    minutes: list[MinuteResult]
    carry_in: tuple[int, int]
    carry_out: tuple[int, int]
    cand_last: tuple[int, int]
    counts: dict[str, int] = field(default_factory=dict)


def minute_inputs(
    con: duckdb.DuckDBPyConnection, day_ms: int, agg: str = "agg"
) -> list[MinuteInput]:
    """Eingaben für alle 1 440 Minuten eines Tages (aggTrades nach T-Minute, Klines, Kandidaten)."""
    d0, d1 = day_ms, day_ms + MS_DAY
    rows = con.execute(
        f"""
        WITH mins AS (SELECT CAST({d0} AS BIGINT) + {MS_MIN} * i AS mt, i AS m FROM range(1440) r(i)),
        a AS (
            SELECT t - t % {MS_MIN} AS mt, sum(q) AS q, sum(q) FILTER (WHERE NOT m) AS b,
                   sum(q) FILTER (WHERE l > f AND t % {MS_MIN} >= {CAND_FROM_MS_OF_MINUTE}) AS cq,
                   sum(q) FILTER (WHERE l > f AND t % {MS_MIN} >= {CAND_FROM_MS_OF_MINUTE}
                                  AND NOT m) AS cb,
                   arg_min(px, id) AS o, max(px) AS h, min(px) AS lo, arg_max(px, id) AS c
            FROM {agg} WHERE t >= {d0} AND t < {d1} GROUP BY 1),
        k AS (SELECT ts AS mt, vol, taker_buy, open_px, high_px, low_px, close_px
              FROM kl WHERE ts >= {d0} AND ts < {d1})
        SELECT mins.m, a.q IS NOT NULL, coalesce(a.q, 0), coalesce(a.b, 0),
               k.vol IS NOT NULL, coalesce(k.vol, 0), coalesce(k.taker_buy, 0),
               coalesce(a.cq, 0), coalesce(a.cb, 0),
               a.o, a.h, a.lo, a.c, k.open_px, k.high_px, k.low_px, k.close_px
        FROM mins LEFT JOIN a USING (mt) LEFT JOIN k USING (mt) ORDER BY mins.m"""
    ).fetchall()
    out = []
    for r in rows:
        mi = MinuteInput(
            m=r[0],
            ours_present=r[1],
            ours_q=int(r[2]),
            ours_b=int(r[3]),
            kl_present=r[4],
            kl_q=int(r[5]),
            kl_b=int(r[6]),
            cand_q=int(r[7]),
            cand_b=int(r[8]),
            ours_ohlc=(r[9], r[10], r[11], r[12]) if r[1] else None,
            kl_ohlc=(r[13], r[14], r[15], r[16]) if r[4] else None,
        )
        out.append(mi)
    return out


def _measure(d: int, s_prev: int, cand: int, cand_prev: int) -> tuple[str, int, int]:
    """Klasse einer Messgröße, ungeklemmter und (ggf. begrenzter) Übertrag."""
    raw = s_prev + d
    if d == 0 and raw == 0:
        return "exact", raw, raw
    if -cand_prev <= d <= cand and 0 <= raw <= cand:
        return "shift", raw, raw
    return "mismatch", raw, min(max(raw, 0), cand)


_RANK = {"exact": 0, "shift": 1, "mismatch": 2, "missing": 3}


def classify_day(
    mins: list[MinuteInput],
    carry_in: tuple[int, int] = (0, 0),
    cand_prev_last: tuple[int, int] = (0, 0),
    prev_available: bool = True,
    next_available: bool = True,
) -> DayClassification:
    """Klassifiziert einen Tag. ``carry_in`` = s(−1) je (q, b); ``cand_prev_last`` = cand(−1)."""
    s_q, s_b = carry_in
    cp_q, cp_b = cand_prev_last
    results: list[MinuteResult] = []
    for mi in mins:
        d_q = mi.ours_q - mi.kl_q
        d_b = mi.ours_b - mi.kl_b
        cq, rq, nq = _measure(d_q, s_q, mi.cand_q, cp_q)
        cb, rb, nb = _measure(d_b, s_b, mi.cand_b, cp_b)
        own = cq if _RANK[cq] >= _RANK[cb] else cb
        # missing: Kline mit Volumen ohne eigene Zeile oder eigene Zeile ohne Kline-Volumen.
        missing = (mi.kl_q > 0 and not mi.ours_present) or (
            mi.ours_present and (not mi.kl_present or mi.kl_q == 0)
        )
        if missing:
            own = "missing"
            nq = min(max(rq, 0), mi.cand_q)
            nb = min(max(rb, 0), mi.cand_b)
        cls = own
        if (mi.m == 0 and not prev_available) or (mi.m == 1439 and not next_available):
            cls = "edge_pending"
        results.append(
            MinuteResult(
                m=mi.m,
                cls=cls,
                own_cls=own,
                d_q=d_q,
                d_b=d_b,
                cand_q=mi.cand_q,
                cand_b=mi.cand_b,
                s_q=nq,
                s_b=nb,
                raw_s_q=rq,
                raw_s_b=rb,
                cls_q=cq,
                cls_b=cb,
            )
        )
        s_q, s_b = nq, nb
        cp_q, cp_b = mi.cand_q, mi.cand_b
    counts: dict[str, int] = {}
    for r in results:
        counts[r.cls] = counts.get(r.cls, 0) + 1
    return DayClassification(
        minutes=results,
        carry_in=carry_in,
        carry_out=(s_q, s_b),
        cand_last=(mins[-1].cand_q, mins[-1].cand_b),
        counts=counts,
    )


def totals(mins: list[MinuteInput], dc: DayClassification, prev_cand_last: tuple[int, int]) -> dict:
    """Tagessummen-Identität Σ unser − Σ kline = s(1439) − s(−1) mit Kandidatengrenzen (§4.6)."""
    out = {}
    for key, ours, kl, i in (
        ("q", [m.ours_q for m in mins], [m.kl_q for m in mins], 0),
        ("b", [m.ours_b for m in mins], [m.kl_b for m in mins], 1),
    ):
        diff = sum(ours) - sum(kl)
        s_in, s_out = dc.carry_in[i], dc.carry_out[i]
        # Unbegrenzter Übertrag: die Identität gilt exakt, wenn nirgends geklemmt wurde.
        raw_out = s_in + diff
        out[key] = {
            "ours": sum(ours),
            "kline": sum(kl),
            "diff": diff,
            "carry_in": s_in,
            "carry_out": s_out,
            "identity": diff == raw_out - s_in and raw_out == s_out,
            "carry_in_in_bounds": 0 <= s_in <= prev_cand_last[i],
            "carry_out_in_bounds": 0 <= s_out <= dc.cand_last[i],
        }
    out["identity"] = out["q"]["identity"] and out["b"]["identity"]
    out["bounds_ok"] = all(
        out[k][f] for k in ("q", "b") for f in ("carry_in_in_bounds", "carry_out_in_bounds")
    )
    return out


def ohlc_report(mins: list[MinuteInput]) -> dict:
    """OHLC-Vergleich als Bericht; Abweichung 'erklärt', wenn Minute m oder m−1 Kandidaten hat."""
    counts = {"open": 0, "high": 0, "low": 0, "close": 0}
    unexplained = 0
    compared = 0
    prev_cand = 0
    for mi in mins:
        if mi.ours_ohlc and mi.kl_ohlc:
            compared += 1
            diffs = [a != b for a, b in zip(mi.ours_ohlc, mi.kl_ohlc, strict=True)]
            for name, flag in zip(counts, diffs, strict=True):
                counts[name] += int(flag)
            if any(diffs) and not (mi.cand_q > 0 or prev_cand > 0):
                unexplained += 1
        prev_cand = mi.cand_q
    return {"compared": compared, **counts, "unexplained_minutes": unexplained}
