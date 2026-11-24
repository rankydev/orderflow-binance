"""Kleine synthetische Welt mit von Hand gerechneten Erwartungen (Datei-Layout wie data.binance.vision).

Tag D = 2026-01-02, Vortag und Folgetag haben je einen Straddler-Fall. Preise 2 Nachkommastellen
(price_unit 0.01), Mengen 3 (Lots 0.001). Die Klines werden aus den Einzelfills gebaut (so entstehen
sie bei Binance); Überschreibungen erzeugen mismatch/missing.

Zeiten sind Millisekunden relativ zu Mitternacht UTC von D. Trade-IDs der Fills = aggTrade-f/l.
"""

from __future__ import annotations

import datetime as dt
import zipfile
from pathlib import Path

D = dt.date(2026, 1, 2)
D0 = (D - dt.date(1970, 1, 1)).days * 86_400_000
DAY = 86_400_000
SYM = "BTCUSDT"


def fmt(lots: int, dec: int = 3) -> str:
    return f"{lots // 10**dec}.{lots % 10**dec:0{dec}d}"


def px_s(p: int) -> str:
    return f"{p // 100}.{p % 100:02d}"


# (agg_id, px, lots, f, l, T-Offset, is_buyer_maker)
AGGS_D = [
    (51, 10050, 10, 101, 101, 1000, False),
    (52, 10060, 20, 102, 103, 2000, True),
    (53, 10050, 30, 104, 104, 3000, False),
    (54, 10040, 5, 105, 105, 4000, True),
    (55, 10070, 100, 106, 106, 61000, False),
    (56, 10070, 200, 107, 109, 119950, True),  # Straddler: 50 Lots Minute 1, 150 Lots Minute 2
    (57, 10070, 1, 110, 110, 125000, False),
    (58, 10080, 40, 111, 111, 181000, False),
    (59, 10065, 2, 112, 112, 241000, True),
    (60, 10090, 3, 113, 113, 419999, False),  # letzte ms der Minute 6
    (61, 10095, 4, 114, 114, 420000, False),  # erste ms der Minute 7
    (62, 10100, 30, 115, 116, DAY - 100, False),  # Straddler über Mitternacht (10 / 20 Lots)
]
AGGS_PREV = [(50, 10010, 20, 90, 91, -100, False)]  # 12 Lots vor, 8 Lots nach Mitternacht
AGGS_NEXT = [(63, 10110, 7, 117, 117, DAY + 30000, True)]

# Fills (trade_id, px, lots, time-offset, is_buyer_maker); Einzelfills ohne Eintrag = aggTrade selbst
FILLS_SPECIAL = {
    52: [(102, 10060, 10, 2000, True), (103, 10060, 10, 2000, True)],
    56: [
        (107, 10070, 50, 119950, True),
        (108, 10070, 100, 120010, True),
        (109, 10070, 50, 120040, True),
    ],
    62: [(115, 10100, 10, DAY - 100, False), (116, 10100, 20, DAY + 10, False)],
    50: [(90, 10010, 12, -100, False), (91, 10010, 8, 5, False)],
}


def all_aggs():
    return AGGS_PREV + AGGS_D + AGGS_NEXT


def all_fills():
    out = []
    for a in all_aggs():
        if a[0] in FILLS_SPECIAL:
            out += FILLS_SPECIAL[a[0]]
        else:
            out.append((a[3], a[1], a[2], a[5], a[6]))
    return out


def _write_zip(path: Path, name: str, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(name, text)


def agg_csv(aggs, header=True) -> str:
    lines = [
        "agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker"
    ]
    if not header:
        lines = []
    for i, p, q, f, ll, t, m in aggs:
        lines.append(f"{i},{px_s(p)},{fmt(q)},{f},{ll},{D0 + t},{'true' if m else 'false'}")
    return "\n".join(lines) + "\n"


def kline_rows(fills):
    """Klines je Fill-Minute aus Einzelfills: (minute_ms, o, h, l, c, vol, taker, count, quote)."""
    by_min: dict[int, list] = {}
    for f in sorted(fills, key=lambda x: x[0]):
        by_min.setdefault((D0 + f[3]) // 60000 * 60000, []).append(f)
    rows = {}
    for mt, fs in by_min.items():
        pxs = [f[1] for f in fs]
        rows[mt] = {
            "o": pxs[0],
            "h": max(pxs),
            "l": min(pxs),
            "c": pxs[-1],
            "vol": sum(f[2] for f in fs),
            "taker": sum(f[2] for f in fs if not f[4]),
            "n": len(fs),
            "quote": sum(f[1] * f[2] for f in fs),
        }
    return rows


def kline_csv(rows: dict[int, dict], day_ms: int, header=True) -> str:
    lines = [
        "open_time,open,high,low,close,volume,close_time,quote_volume,count,"
        "taker_buy_volume,taker_buy_quote_volume,ignore"
    ]
    if not header:
        lines = []
    for mt in sorted(rows):
        if not day_ms <= mt < day_ms + DAY:
            continue
        r = rows[mt]
        quote = f"{r['quote'] // 10**5}.{r['quote'] % 10**5:05d}000"
        lines.append(
            f"{mt},{px_s(r['o'])},{px_s(r['h'])},{px_s(r['l'])},{px_s(r['c'])},{fmt(r['vol'])},"
            f"{mt + 59999},{quote},{r['n']},{fmt(r['taker'])},0.00000000,0"
        )
    return "\n".join(lines) + "\n"


def trades_csv(fills, day_ms: int) -> str:
    lines = ["id,price,qty,quote_qty,time,is_buyer_maker"]
    for i, p, q, t, m in sorted(fills):
        if day_ms <= D0 + t < day_ms + DAY:
            lines.append(f"{i},{px_s(p)},{fmt(q)},0,{D0 + t},{'true' if m else 'false'}")
    return "\n".join(lines) + "\n"


def build_world(
    root: Path,
    *,
    bad: bool = False,
    prev: bool = True,
    nxt: bool = True,
    header: bool = True,
    trades: bool = False,
    shuffle: bool = False,
    off_by_one: bool = False,
) -> Path:
    """Schreibt Rohdateien unter root und liefert root zurück."""
    kl = kline_rows(all_fills())
    if bad:
        kl[D0 + 3 * 60000]["vol"] = 50  # Minute 3: Kline 50 statt 40 Lots -> mismatch
        kl[D0 + 3 * 60000]["taker"] = 40
        del kl[D0 + 4 * 60000]  # Minute 4: eigene Zeile ohne Kline -> missing
        kl[D0 + 5 * 60000] = {
            "o": 10000, "h": 10000, "l": 10000, "c": 10000,
            "vol": 7, "taker": 2, "n": 2, "quote": 70000,
        }  # fmt: skip  # Minute 5: Kline ohne eigene Zeile -> missing
    aggs_by_day = {
        D - dt.timedelta(days=1): AGGS_PREV,
        D: AGGS_D,
        D + dt.timedelta(days=1): AGGS_NEXT,
    }
    for day, aggs in aggs_by_day.items():
        if (day < D and not prev) or (day > D and not nxt):
            continue
        aggs = list(aggs)
        if off_by_one and day == D:  # Agg 61 (T = Minutengrenze) fälschlich in die Vorminute
            aggs = [(*a[:5], 419999, a[6]) if a[0] == 61 else a for a in aggs]
        if shuffle:
            aggs = aggs[::-1]
        d = day.isoformat()
        dms = (day - dt.date(1970, 1, 1)).days * DAY
        _write_zip(
            root / f"daily/aggTrades/{SYM}/{SYM}-aggTrades-{d}.zip",
            f"{SYM}-aggTrades-{d}.csv",
            agg_csv(aggs, header),
        )
        _write_zip(
            root / f"daily/klines/{SYM}/1m/{SYM}-1m-{d}.zip",
            f"{SYM}-1m-{d}.csv",
            kline_csv(kl, dms, header),
        )
        if trades:
            _write_zip(
                root / f"daily/trades/{SYM}/{SYM}-trades-{d}.zip",
                f"{SYM}-trades-{d}.csv",
                trades_csv(all_fills(), dms),
            )
    return root
