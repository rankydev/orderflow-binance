"""Opt-in (OF_VERIFIER_SLOW=1): Reproduktion der unabhängig gemessenen Fakten auf echten Tagen.

Liest nur lesend unter data/raw/binance-vision/futures/um (je Tag ca. 5–10 s, bis 4,5 GB RAM).
"""

import pytest

from orderflow_verifier import deepcheck
from orderflow_verifier.files import DEFAULT_ROOT
from orderflow_verifier.units import symbol_spec
from orderflow_verifier.verify import verify_day

pytestmark = pytest.mark.slow

# (Symbol, Tag): (Minuten mit exaktem Volumen, mit exaktem Taker-Buy) — gemessen mit exakter
# Dezimalrechnung, aggTrades nach T gegen 1m-Klines (Messung vor der Implementierung).
REFERENCE = {
    ("BTCUSDT", "2026-11-20"): (1090, 1246),
    ("BTCUSDT", "2026-11-21"): (1115, 1271),
    ("BTCUSDT", "2026-11-22"): (1243, 1310),
    ("ETHUSDT", "2026-11-21"): (1209, 1323),
    ("ETHUSDT", "2026-11-22"): (1308, 1381),
}

_cache: dict = {}


def run(sym, day, deep=True):
    key = (sym, day)
    if key not in _cache:
        spec = symbol_spec(sym)
        res, con = verify_day(DEFAULT_ROOT, spec, day)
        if deep:
            res["deep"] = deepcheck.deep_check(
                con, DEFAULT_ROOT, spec, day, minute_classes=res["classification"]["minutes"]
            )
        _cache[key] = res
    return _cache[key]


@pytest.mark.parametrize(("sym", "day"), sorted(REFERENCE))
def test_reference_day(sym, day):
    r = run(sym, day)
    c = r["classification"]
    assert (c["exact_volume_minutes"], c["exact_taker_buy_minutes"]) == REFERENCE[(sym, day)]
    assert c["counts"]["mismatch"] == 0 and c["counts"]["missing"] == 0
    assert c["counts"]["edge_pending"] == 0
    assert c["counts"]["exact"] + c["counts"]["shift"] == 1440
    assert r["state"] == "final_ok"
    assert r["totals"]["identity"] and r["totals"]["bounds_ok"]
    m = r["manifest"]
    assert m["checksum"]["ok"] and m["klines_checksum"]["ok"]
    assert (m["agg_id_holes"], m["agg_id_dups"], m["ts_backwards"]) == (0, 0, 0)
    assert m["continues_prev"] is True


def test_known_edges():
    e20 = run("BTCUSDT", "2026-11-20")["classification"]
    assert e20["edges"][0]["d_q"] == -13  # letzter aggTrade vom 19.11. reicht über Mitternacht
    assert e20["edges"][0]["class"] == "shift"
    e22 = run("BTCUSDT", "2026-11-22")["classification"]
    assert e22["edges"][1]["d_q"] == 19  # Minute 1439 +0,019 BTC
    assert e22["edges"][1]["class"] == "shift"


@pytest.mark.parametrize(
    ("sym", "day"),
    [
        ("BTCUSDT", "2026-11-21"),
        ("BTCUSDT", "2026-11-22"),
        ("ETHUSDT", "2026-11-21"),
        ("ETHUSDT", "2026-11-22"),
    ],
)
def test_deep_check_passes_on_complete_dumps(sym, day):
    d = run(sym, day)["deep"]
    assert d["deep_check"] == "passed", d["failures"]
    assert d["step3"]["minutes_checked"] == 1440
    assert d["step5"]["level_mismatches"] == 0


def test_btc_20_dump_is_unusable_in_late_hours():
    d = run("BTCUSDT", "2026-11-20")["deep"]
    assert d["deep_check"] == "reference_unusable"
    assert d["unusable_hours"] == [19, 20, 21, 22, 23]
    assert d["usable_hours_result"] == "passed"


def test_btc_2026_10_27_has_a_real_hole():
    r = run("BTCUSDT", "2026-10-27", deep=False)
    c = r["classification"]
    assert r["state"] == "final_bad"
    assert c["counts"]["missing"] == 27 and c["counts"]["mismatch"] == 2
    bad = sorted(m["minute"] for m in c["minutes"] if m["class"] in ("mismatch", "missing"))
    assert bad == list(range(2, 31))
    # die aggIds selbst sind lückenlos: die Lücke ist nur über Zeit, Trade-IDs und Klines sichtbar
    assert r["manifest"]["agg_id_holes"] == 0
