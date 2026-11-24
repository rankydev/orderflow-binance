"""Von Hand gerechnete Erwartungen für Basistabelle, Bars, Rollups, Komposita und Digests."""

import hashlib

import pytest

import world as w
from orderflow_verifier.recompute import combine_digests
from orderflow_verifier.units import DIGEST_TABLES, symbol_spec
from orderflow_verifier.verify import verify_day

SPEC = symbol_spec("BTCUSDT")  # sym_id 1, price_decimals 2, qty_decimals 3


@pytest.fixture(scope="module")
def day(tmp_path_factory):
    root = w.build_world(tmp_path_factory.mktemp("raw"))
    result, con = verify_day(root, SPEC, w.D.isoformat())
    return result, con


def q(con, sql):
    return con.execute(sql).fetchall()


def test_fp_1m_minute0_levels(day):
    _, con = day
    rows = q(
        con, f"SELECT px, buy_q, sell_q, buy_a, sell_a FROM fp_1m WHERE ts = {w.D0} ORDER BY px"
    )
    # 100.40: ein Verkauf (5); 100.50: zwei Käufe (10 + 30); 100.60: ein Verkauf (20)
    assert rows == [(10040, 0, 5, 0, 1), (10050, 40, 0, 2, 0), (10060, 0, 20, 0, 1)]


def test_minute_assignment_at_boundaries(day):
    _, con = day
    # id 60 hat T = Minutengrenze - 1 ms (Minute 6), id 61 T = Minutengrenze (Minute 7)
    got = dict(q(con, f"SELECT first_agg_id, (ts - {w.D0}) / 60000 FROM bar_1m"))
    assert got[60] == 6
    assert got[61] == 7


def test_bar_1m_minute0_statistics(day):
    _, con = day
    (r,) = q(con, f"SELECT * FROM bar_1m WHERE ts = {w.D0}")
    cols = [c[0] for c in con.description]
    b = dict(zip(cols, r, strict=True))
    assert (b["open_px"], b["high_px"], b["low_px"], b["close_px"]) == (10050, 10060, 10040, 10040)
    assert (b["buy_q"], b["sell_q"], b["buy_a"], b["sell_a"]) == (40, 25, 2, 2)
    # Σ px*lots = 10050*10 + 10060*20 + 10050*30 + 10040*5
    assert b["notional"] == 653_400
    assert (b["first_agg_id"], b["last_agg_id"]) == (51, 54)
    assert (b["first_trade_ms"], b["last_trade_ms"]) == (w.D0 + 1000, w.D0 + 4000)
    # laufendes Delta nach jedem aggTrade: +10, -10, +20, +15 -> max 20, min -10 (Start 0 zählt nicht)
    assert (b["run_max"], b["run_min"]) == (20, -10)
    # erster Print auf low 10040 ist id 54 (-5); erster auf high 10060 ist id 52: 15 - 10 = 5
    assert (b["d_from_low"], b["d_from_high"]) == (-5, 5)
    assert b["source"] == 3


def test_run_max_min_exclude_start_value(day):
    _, con = day
    # Minute 4 hat nur einen Verkauf (-2): max-Delta ist -2 (nicht 0), min -2
    (r,) = q(
        con,
        f"SELECT run_max, run_min, d_from_low, d_from_high FROM bar_1m WHERE ts = {w.D0 + 4 * 60000}",
    )
    assert r == (-2, -2, -2, -2)


def test_rollups_hand_values(day):
    _, con = day
    # alle Preise 100.40..100.95 liegen im 1-$-Bin 100.xx = 10000..10099 -> floor(px/100)*100 = 10000
    # (px 10100 aus Agg 62 -> 10100)
    m0 = q(con, f"SELECT px, buy_q, sell_q, buy_a, sell_a FROM fp_1m_b10 WHERE ts = {w.D0}")
    assert m0 == [(10000, 40, 25, 2, 2)]
    # 5m: Minuten 0..4 gehören ins Fenster 0; Käufe 10+30+100+1+40 = 181, Verkäufe 5+20+200+2 = 227
    f5 = q(con, f"SELECT px, buy_q, sell_q FROM fp_5m_b10 WHERE ts = {w.D0} ORDER BY px")
    assert f5 == [(10000, 181, 227)]
    # 15m_b100: Zeilenbreite 1000: alle Preise < 10100 -> 10000
    f15 = q(con, f"SELECT px, buy_q, sell_q, buy_a, sell_a FROM fp_15m_b100 WHERE ts = {w.D0}")
    # Käufe: 10+30+100+1+40+3+4 = 188, Verkäufe 5+20+200+2 = 227; Anzahl Käufe 7 (51,53,55,57,58,60,61), Verkäufe 4 (52,54,56,59)
    assert f15 == [(10000, 188, 227, 7, 4)]
    # 1d_b1000: Breite 10000 -> eine Zeile 10000 mit allen Mengen inkl. Agg 62 (30 Käufe)
    d1000 = q(con, "SELECT px, buy_q, sell_q, buy_a, sell_a FROM fp_1d_b1000")
    assert d1000 == [(10000, 218, 227, 8, 4)]
    # 1d_b100: Breite 1000; ebenfalls eine Zeile
    assert q(con, "SELECT px, buy_q FROM fp_1d_b100") == [(10000, 218)]


def test_rollup_sums_equal_base(day):
    _, con = day
    base = q(con, "SELECT sum(buy_q), sum(sell_q), sum(buy_a), sum(sell_a) FROM fp_1m")
    for t in DIGEST_TABLES[1:8]:
        assert q(con, f"SELECT sum(buy_q), sum(sell_q), sum(buy_a), sum(sell_a) FROM {t}") == base


def test_bar_1h_composition_by_hand(day):
    _, con = day
    (r,) = q(con, f"SELECT * FROM bar_1h WHERE ts = {w.D0}")
    b = dict(zip([c[0] for c in con.description], r, strict=True))
    # Folge der aggTrades 51..61 mit Delta: +10 -10 +30 -5 +100 -200 +1 +40 -2 +3 +4
    # kumuliert: 10, -10, 20, 15, 115, -85, -84, -44, -46, -43, -39
    assert b["run_max"] == 115
    assert b["run_min"] == -85
    # COT High: erster Print auf Stunden-Low 10040 ist id 54 (Minute 0): -5 + (100-200+1+40-2+3+4) = -59
    assert b["d_from_low"] == -59
    # COT Low: Stunden-High 10095 (id 61, Minute 7): +4
    assert b["d_from_high"] == 4
    assert (b["open_px"], b["close_px"]) == (10050, 10095)
    assert (b["high_px"], b["low_px"]) == (10095, 10040)
    assert (b["first_agg_id"], b["last_agg_id"]) == (51, 61)
    assert (b["buy_q"], b["sell_q"]) == (188, 227)


def test_cot_low_prefers_first_minute_with_extreme(day):
    _, con = day
    # bar_1d enthält zusätzlich Agg 62 (Minute 1439, 10100 = neues High, +30)
    (r,) = q(con, "SELECT run_max, run_min, d_from_low, d_from_high, high_px FROM bar_1d")
    assert r[4] == 10100
    assert r[3] == 30  # d_from_high: ab dem High in Minute 1439 nur der eigene Trade
    assert (r[0], r[1]) == (115, -85)
    assert (
        r[2] == -59 + 30
    )  # Delta ab dem Low-Print (id 54) bis Tagesende, Agg 62 (+30) eingeschlossen


def test_digest_text_form_by_hand(day):
    result, con = day
    # fp_1m: sortiert nach (ts, px), Postgres-Zeilentext mit quotierter Zeit
    rows = q(con, "SELECT ts, px, buy_q, sell_q, buy_a, sell_a FROM fp_1m ORDER BY ts, px LIMIT 3")
    assert rows[0][0] == w.D0
    text = "\n".join(
        f'(1,"2026-01-02 00:00:00+00",{px},{b},{s},{ba},{sa})' for _, px, b, s, ba, sa in rows
    )
    full = q(con, "SELECT count(*) FROM fp_1m")[0][0]
    assert full == result["tables"]["fp_1m"]["rows"]
    # Digest der bar_1d-Zeile von Hand zusammengesetzt
    (r,) = q(con, "SELECT * FROM bar_1d")
    expected_text = '(1,"2026-01-02 00:00:00+00",' + ",".join(str(v) for v in r[1:]) + ")"
    assert (
        result["tables"]["bar_1d"]["digest"] == hashlib.sha256(expected_text.encode()).hexdigest()
    )
    assert text.startswith('(1,"2026-01-02 00:00:00+00",10040,0,5,0,1)')


def test_bar_1m_digest_includes_source_not_check_state(day):
    result, con = day
    rows = q(con, "SELECT * FROM bar_1m ORDER BY ts")
    lines = [f'(1,"{_ts(r[0])}",{",".join(str(v) for v in r[1:])})' for r in rows]
    assert lines[0].endswith(",3)")  # source = 3 (vision) am Ende, kein check_state
    assert (
        result["tables"]["bar_1m"]["digest"]
        == hashlib.sha256("\n".join(lines).encode()).hexdigest()
    )


def _ts(ms):
    import datetime as dt

    return dt.datetime.fromtimestamp(ms / 1000, dt.UTC).strftime("%Y-%m-%d %H:%M:%S+00")


def test_combined_digest_form(day):
    result, _ = day
    parts = [f"{t}:{result['tables'][t]['digest']}" for t in DIGEST_TABLES]
    assert result["day_digest"] == hashlib.sha256("\n".join(parts).encode()).hexdigest()
    assert (
        combine_digests({t: result["tables"][t]["digest"] for t in DIGEST_TABLES})
        == result["day_digest"]
    )


def test_empty_table_digest_is_sha256_of_empty_string():
    import duckdb

    from orderflow_verifier.recompute import table_digest

    con = duckdb.connect()
    con.execute(
        "CREATE TABLE kline_1m (ts BIGINT, open_px BIGINT, high_px BIGINT, low_px BIGINT, "
        "close_px BIGINT, vol BIGINT, taker_buy BIGINT, trades BIGINT, quote_vol_n BIGINT)"
    )
    assert table_digest(con, "kline_1m", 1) == (hashlib.sha256(b"").hexdigest(), 0)


def test_kline_table_parsed_exactly(day):
    _, con = day
    (r,) = q(
        con,
        f"SELECT open_px, high_px, low_px, close_px, vol, taker_buy, trades, quote_vol_n FROM kline_1m WHERE ts = {w.D0}",
    )
    # Minute 0 der Klines: eigene Fills (65 Lots) + 8 Lots aus dem Vortags-Straddler
    assert r[4] == 73 and r[5] == 48 and r[6] == 6
    assert r[7] == 10050 * 10 + 10060 * 10 * 2 + 10050 * 30 + 10040 * 5 + 10010 * 8


def test_shuffled_input_gives_identical_digests(tmp_path_factory):
    a = verify_day(w.build_world(tmp_path_factory.mktemp("a")), SPEC, w.D.isoformat())[0]
    b = verify_day(
        w.build_world(tmp_path_factory.mktemp("b"), shuffle=True), SPEC, w.D.isoformat()
    )[0]
    assert a["day_digest"] == b["day_digest"]


def test_missing_header_is_detected(tmp_path_factory):
    a = verify_day(w.build_world(tmp_path_factory.mktemp("h1")), SPEC, w.D.isoformat())[0]
    b = verify_day(
        w.build_world(tmp_path_factory.mktemp("h2"), header=False), SPEC, w.D.isoformat()
    )[0]
    assert a["day_digest"] == b["day_digest"]
    assert a["manifest"]["header_present"] is True
    assert b["manifest"]["header_present"] is False
