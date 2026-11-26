"""Order-Regel v1 (KONZEPT §3.7) und Digest-Version 2 im Verifier: Randfälle von Hand, Zufallsfolgen
gegen eine naive Referenz in Python, Zeilentextform von big_order/order_day und der Datenbankvergleich
je gespeicherter Digest-Version (mit dem DuckDB-Ersatz aus test_deep_db_compare)."""

import hashlib
import random

import duckdb
import pytest

import world as w
from orderflow_verifier import dbmode
from orderflow_verifier import recompute as rc
from orderflow_verifier.units import DIGEST_PARTS, symbol_spec
from orderflow_verifier.verify import verify_day
from test_deep_db_compare import FakeDb

SPEC = symbol_spec("BTCUSDT")
DAY = w.D.isoformat()
D0 = w.D0


def day_con(aggs):
    """DuckDB mit ``agg`` (id, px, q, f, l, t, m) und leeren Klines; Tabellen des Tages gebaut."""
    con = duckdb.connect()
    con.execute(
        "CREATE TABLE agg (id BIGINT, px BIGINT, q BIGINT, f BIGINT, l BIGINT, t BIGINT, "
        "m BOOLEAN, src VARCHAR)"
    )
    con.executemany(
        "INSERT INTO agg VALUES (?, ?, ?, ?, ?, ?, ?, 'x')",
        [(a, px, q, a, a, t, m) for a, px, q, t, m in aggs],
    )
    con.execute(
        "CREATE TABLE kl (ts BIGINT, open_px BIGINT, high_px BIGINT, low_px BIGINT, "
        "close_px BIGINT, vol BIGINT, taker_buy BIGINT, trades BIGINT, quote_vol_n BIGINT)"
    )
    return con


def run_orders(aggs, floor):
    con = day_con(aggs)
    totals = rc.build_day_tables(con, SPEC, D0, floor)
    big = con.execute(
        "SELECT ts, first_agg_id, last_agg_id, side, px_first, px_last, qty, notional, agg_n "
        "FROM big_order ORDER BY ts, first_agg_id"
    ).fetchall()
    return totals, big, con


def ref_orders(aggs):
    """Naive Referenz: Liste von Orders als Listen von aggTrades (aggId-Reihenfolge)."""
    out = []
    for a in sorted(aggs):
        last = out[-1][-1] if out else None
        if last and last[3] == a[3] and last[4] == a[4] and a[0] == last[0] + 1:
            out[-1].append(a)
        else:
            out.append([a])
    return out


def ref_row(o):
    return (
        o[0][3],
        o[0][0],
        o[-1][0],
        2 if o[0][4] else 1,
        o[0][1],
        o[-1][1],
        sum(x[2] for x in o),
        sum(x[1] * x[2] for x in o),
        len(o),
    )


def test_edge_cases_by_hand():
    last = D0 + 86_400_000 - 1
    aggs = [
        (1, 1000, 10, D0, False),  # erster ms des Tages, Order mit 2 aggTrades
        (2, 1001, 10, D0, False),
        (3, 1000, 10, D0, True),  # gleiche ms, andere Seite → neue Order
        (5, 1000, 10, D0, True),  # gleiche ms und Seite, aber ID-Loch → neue Order
        (6, 1000, 10, D0 + 1000, False),  # gleiche ms wie 7/8, 7 andere Seite dazwischen
        (7, 1000, 10, D0 + 1000, True),
        (8, 1000, 10, D0 + 1000, False),  # nicht fortlaufend zu 6 → neue Order
        (9, 1000, 10, last, True),  # letzter ms des Tages, 3 aggTrades
        (10, 999, 10, last, True),
        (11, 998, 7, last, True),
    ]
    totals, big, _ = run_orders(aggs, 1)
    assert totals["orders_n"] == 7
    assert totals["reconciled"] is True
    assert [(r[0] - D0, r[1], r[2], r[3], r[8]) for r in big] == [
        (0, 1, 2, 1, 2),
        (0, 3, 3, 2, 1),
        (0, 5, 5, 2, 1),
        (1000, 6, 6, 1, 1),
        (1000, 7, 7, 2, 1),
        (1000, 8, 8, 1, 1),
        (86_399_999, 9, 11, 2, 3),
    ]
    assert big[-1][4:8] == (1000, 998, 27, 1000 * 10 + 999 * 10 + 998 * 7)


def test_floor_boundary_and_no_floor():
    aggs = [(1, 1000, 3, D0 + 5, False), (2, 1000, 2, D0 + 5, False)]
    assert len(run_orders(aggs, 5000)[1]) == 1  # notional = floor wird gespeichert
    assert len(run_orders(aggs, 5001)[1]) == 0
    totals, big, _ = run_orders(aggs, None)
    assert big == []
    assert (totals["orders_n"], totals["orders_notional"], totals["big_floor_n"]) == (1, 5000, None)
    for bad in (0, -1, 1.5):
        with pytest.raises(ValueError, match="big_floor_n"):
            run_orders(aggs, bad)


def test_time_backwards_within_minute_splits_and_sorts():
    aggs = [
        (1, 1000, 1, D0 + 500, False),
        (2, 1000, 1, D0 + 100, True),
        (3, 1000, 1, D0 + 100, True),
    ]
    _, big, _ = run_orders(aggs, 1)
    assert [(r[0] - D0, r[1], r[8]) for r in big] == [(100, 2, 2), (500, 1, 1)]


@pytest.mark.parametrize("seed", range(40))
def test_random_sequences_match_naive_reference(seed):
    rnd = random.Random(seed)
    t, a, m, px = D0 + 59_990, 1000, False, 600_000
    aggs = []
    for _ in range(rnd.randint(1, 300)):
        r = rnd.random()
        dt = 0 if r < 0.55 else rnd.randint(1, 5) if r < 0.8 else rnd.randint(1, 90_000)
        if rnd.random() < 0.08:  # rückwärts, aber nicht über eine Minutengrenze
            dt = -rnd.randint(1, 40)
        t = min(D0 + 86_399_999, max(t - t % 60_000, t + dt))
        if rnd.random() < 0.2:
            m = not m
        a += 1 + (rnd.randint(1, 3) if rnd.random() < 0.1 else 0)
        px = max(10, px + rnd.randint(-3, 3) * 10)
        aggs.append((a, px, rnd.choice([rnd.randint(1, 20), rnd.randint(1, 200_000)]), t, m))
    floor = rnd.randint(1, 3_000_000_000)
    totals, big, _ = run_orders(aggs, floor)
    ref = ref_orders([(x[0], x[1], x[2], x[3], x[4]) for x in aggs])
    assert totals["orders_n"] == len(ref)
    assert totals["orders_notional"] == sum(x[1] * x[2] for x in aggs)
    assert totals["reconciled"] is True
    want = sorted((ref_row(o) for o in ref if ref_row(o)[7] >= floor), key=lambda r: (r[0], r[1]))
    assert big == want


def test_big_order_row_text_with_milliseconds():
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731
    base = 1795132800000  # 2026-11-20 00:00:00 UTC
    aggs = [
        (10, 6195920, 10, base, True),
        (11, 6195900, 20, base + 120, True),
        (12, 6195900, 5, base + 7, False),
    ]
    con = day_con(aggs)
    rc.build_day_tables(con, SPEC, base, 1)
    got = rc.table_digest(con, "big_order", 1)
    lines = [
        '(1,"2026-11-20 00:00:00+00",10,10,2,6195920,6195920,10,61959200,1)',
        '(1,"2026-11-20 00:00:00.007+00",12,12,1,6195900,6195900,5,30979500,1)',
        '(1,"2026-11-20 00:00:00.12+00",11,11,2,6195900,6195900,20,123918000,1)',
    ]
    assert got == (sha("\n".join(lines)), 3)
    assert rc.order_day_digest(1, "2026-11-20", 5, 123, None) == sha("(1,2026-11-20,5,123,)")
    assert rc.order_day_digest(1, "2026-11-20", 5, 123, 50_000_000_000) == sha(
        "(1,2026-11-20,5,123,50000000000)"
    )
    with pytest.raises(ValueError, match="Digest-Version"):
        rc.combine_digests({}, 3)


# --- Datenbankvergleich je gespeicherter Digest-Version (DuckDB-Ersatz) ---------------------------

FLOOR = 100_000  # in der synthetischen Welt liegen mehrere Orders darüber (z. B. 10050 · 10)


def fake(tmp_path, floor=FLOOR, corrupt=None, day_overrides=None):
    root = w.build_world(tmp_path)
    res, con = verify_day(root, SPEC, DAY, checksums=False, big_floor_n=floor)
    return root, FakeDb(con, SPEC, res, corrupt, day_overrides), res, con


def test_world_has_big_orders(tmp_path):
    _, _, res, _ = fake(tmp_path)
    o = res["orders"]
    assert o["big_orders"] > 0 and o["big_orders"] < o["orders_n"]
    assert o["reconciled"] and o["orders_notional"] == o["bars_notional"]


def test_v2_day_verifies_with_order_data(tmp_path):
    _, fx, res, con = fake(tmp_path)
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert out["equal"], out
    assert out["verified_version"] == 2
    assert out["order_data"] == "verified"
    assert list(out["tables"]) == list(DIGEST_PARTS[2])


def test_v1_day_verifies_as_v1_without_false_alarm_or_order_claim(tmp_path):
    root = w.build_world(tmp_path)
    res, con = verify_day(root, SPEC, DAY, checksums=False, big_floor_n=None)
    v1 = {
        "digest_version": 1,
        "digest": res["day_digests"]["1"],
        "orders_n": None,
        "orders_notional": None,
        "big_floor_n": None,
    }
    fx = FakeDb(con, SPEC, res, "DELETE FROM big_order", v1)
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert out["equal"], out
    assert out["verified_version"] == 1
    assert out["order_data"].startswith("absent")
    assert "big_order" not in out["tables"] and "order_day" not in out["tables"]
    # ein v1-Tag mit Ordersummen passt nicht zu seinem Digest
    fx2 = FakeDb(con, SPEC, res, "DELETE FROM big_order", {**v1, "orders_n": 5})
    assert not dbmode.compare_with_fetcher(fx2, con, SPEC, res, DAY)["equal"]


def test_v1_digest_stored_as_v2_is_no_match(tmp_path):
    root = w.build_world(tmp_path)
    res, con = verify_day(root, SPEC, DAY, checksums=False, big_floor_n=FLOOR)
    fx = FakeDb(con, SPEC, res, None, {"digest": res["day_digests"]["1"]})  # Version 2 behauptet
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert not out["equal"]
    assert out["quality"]["checks"]["digest"]["equal"] is False


def test_corrupted_big_order_row_is_reported(tmp_path):
    _, fx, res, con = fake(tmp_path, corrupt="UPDATE big_order SET qty = qty + 1 WHERE agg_n = 1")
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert not out["equal"]
    bad = [t for t, v in out["tables"].items() if not v["equal"]]
    assert bad == ["big_order"]
    e = out["tables"]["big_order"]["first"][0]
    assert e["kind"] == "column_differences" and list(e["columns"]) == ["qty"]


def test_wrong_order_totals_in_data_day_are_reported(tmp_path):
    _, fx, res, con = fake(tmp_path, day_overrides={"orders_n": 1})
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert not out["equal"]
    assert out["tables"]["order_day"]["equal"] is False
    assert out["quality"]["checks"]["orders_n"]["equal"] is False


def test_compare_db_recomputes_with_the_days_recorded_floor(tmp_path):
    root, fx, _, _ = fake(tmp_path)
    out = dbmode.compare_db(root, SPEC, DAY, fetcher=fx)
    assert out["equal"], out
    assert out["recomputation"]["orders"]["big_floor_n"] == FLOOR
    # gespeicherte Untergrenze anders als die der big_order-Zeilen: fällt auf
    fx.day["big_floor_n"] = FLOOR * 10
    out = dbmode.compare_db(root, SPEC, DAY, fetcher=fx)
    assert not out["equal"]
    assert out["tables"]["big_order"]["equal"] is False
