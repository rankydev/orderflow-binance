"""Klassifikator (KONZEPT §4.6) an synthetischen Tagen mit von Hand bestimmten Minutenklassen."""

import pytest

import world as w
from orderflow_verifier import classify as cl
from orderflow_verifier.units import symbol_spec
from orderflow_verifier.verify import verify_day

SPEC = symbol_spec("BTCUSDT")
DAYS = w.D.isoformat()


def run(tmp_path_factory, **kw):
    root = w.build_world(tmp_path_factory.mktemp("raw"), **kw)
    result, _ = verify_day(root, SPEC, DAYS)
    by_min = {m["minute"]: m for m in result["classification"]["minutes"]}
    return result, by_min


def test_good_day_classes(tmp_path_factory):
    r, m = run(tmp_path_factory)
    c = r["classification"]
    assert c["counts"] == {
        "exact": 1436,
        "shift": 4,
        "mismatch": 0,
        "missing": 0,
        "edge_pending": 0,
    }
    assert sorted(m) == [0, 1, 2, 1439]
    # Minute 0: Vortags-Straddler (12 Lots vor, 8 nach Mitternacht): D = -8, Übertrag s(-1) = 8
    assert (m[0]["class"], m[0]["d_q"], m[0]["d_b"], m[0]["carry_q"]) == ("shift", -8, -8, 0)
    assert c["carry_in"] == {"q": 8, "b": 8}
    # Minute 1: 200-Lot-Agg, 50 Lots in der Minute: D_q = +150, D_b = 0 (Verkäufer) -> shift (q), exact (b)
    assert (m[1]["class"], m[1]["d_q"], m[1]["d_b"]) == ("shift", 150, 0)
    assert (m[1]["class_q"], m[1]["class_b"]) == ("shift", "exact")
    assert (m[1]["cand_q"], m[1]["cand_b"], m[1]["carry_q"]) == (200, 0, 150)
    # Minute 2: D = -150 wird durch den Übertrag aus Minute 1 ausgeglichen
    assert (m[2]["class"], m[2]["d_q"], m[2]["carry_q"]) == ("shift", -150, 0)
    # Minute 1439: Straddler über Mitternacht, 10 von 30 Lots in der Minute -> D = +20
    assert (m[1439]["class"], m[1439]["d_q"], m[1439]["d_b"], m[1439]["carry_q"]) == (
        "shift", 20, 20, 20,
    )  # fmt: skip
    assert c["carry_out"] == {"q": 20, "b": 20}
    assert c["next_day_minute0"]["class"] == "shift"  # Folgetag Minute 0: D = -20, s = 0
    t = r["totals"]
    assert t["q"]["diff"] == 20 - 8
    assert t["identity"] and t["bounds_ok"]
    assert r["state"] == "final_ok"
    # exakte Minuten (nur Volumen): alle außer 0, 1, 2, 1439 = 1436
    assert c["exact_volume_minutes"] == 1436
    assert c["exact_taker_buy_minutes"] == 1438  # nur Minute 0 und 1439 haben D_b != 0


def test_edge_pending_without_neighbours(tmp_path_factory):
    r, m = run(tmp_path_factory, prev=False, nxt=False)
    assert m[0]["class"] == "edge_pending"
    assert m[1439]["class"] == "edge_pending"
    assert m[0]["own_class"] == "mismatch"  # ohne Vortag ist s(-1) unbekannt (0): D = -8 unerklärt
    assert r["classification"]["counts"]["edge_pending"] == 2
    assert r["classification"]["next_day_minute0"] is None


def test_edge_resolves_with_next_day_only(tmp_path_factory):
    r, m = run(tmp_path_factory, prev=False)
    assert m[0]["class"] == "edge_pending"
    assert m[1439]["class"] == "shift"


def test_bad_day_mismatch_and_missing(tmp_path_factory):
    r, m = run(tmp_path_factory, bad=True)
    c = r["classification"]
    assert c["counts"] == {
        "exact": 1433,
        "shift": 4,
        "mismatch": 1,
        "missing": 2,
        "edge_pending": 0,
    }
    # Minute 3: Kline 50 statt 40 Lots, kein Kandidat -> mismatch, Übertrag auf [0, cand] = 0 begrenzt
    assert (m[3]["class"], m[3]["d_q"], m[3]["carry_q"], m[3]["carry_raw_q"]) == (
        "mismatch",
        -10,
        0,
        -10,
    )
    # Minute 4: eigene Zeile ohne Kline -> missing; Minute 5: Kline ohne eigene Zeile -> missing
    assert m[4]["class"] == "missing" and m[5]["class"] == "missing"
    assert r["state"] == "final_bad"


def test_off_by_one_at_minute_boundary_is_mismatch(tmp_path_factory):
    # Agg 61 (T = Minutengrenze, 4 Lots) wird in die Vorminute gelegt: kein deckender Kandidat
    r, m = run(tmp_path_factory, off_by_one=True)
    assert m[6]["class"] == "mismatch" and m[6]["d_q"] == 4
    # Minute 7 hat nun keine eigene Zeile, die Kline aber 4 Lots -> missing
    assert m[7]["class"] == "missing" and m[7]["d_q"] == -4
    assert r["classification"]["counts"]["mismatch"] == 1
    assert r["classification"]["counts"]["missing"] == 1
    assert r["state"] == "final_bad"


# ---- reine Zustandsautomat-Tests (ohne Dateien) ----


def mi(m, ours_q=0, kl_q=0, cand_q=0, ours_b=None, kl_b=None, cand_b=None, present=True):
    return cl.MinuteInput(
        m=m,
        ours_q=ours_q,
        ours_b=ours_q if ours_b is None else ours_b,
        ours_present=present and ours_q > 0,
        kl_q=kl_q,
        kl_b=kl_q if kl_b is None else kl_b,
        kl_present=kl_q > 0,
        cand_q=cand_q,
        cand_b=cand_q if cand_b is None else cand_b,
    )


def day_of(special: dict[int, cl.MinuteInput]):
    return [special.get(i, cl.MinuteInput(m=i)) for i in range(1440)]


def test_shift_requires_envelope_and_compensation():
    # D = +5 in Minute 10 mit cand 5: shift; Minute 11 gleicht aus (D = -5)
    mins = day_of({10: mi(10, 15, 10, 5), 11: mi(11, 7, 12, 0)})
    dc = cl.classify_day(mins)
    assert [dc.minutes[i].cls for i in (10, 11)] == ["shift", "shift"]
    assert dc.minutes[10].s_q == 5 and dc.minutes[11].s_q == 0


def test_cand_too_small_is_mismatch_and_carry_is_clamped():
    # D = +5 aber cand = 3 -> mismatch; Übertrag wird auf cand = 3 begrenzt, Folgeminute D = -3 -> shift
    mins = day_of({10: mi(10, 15, 10, 3), 11: mi(11, 7, 10, 0)})
    dc = cl.classify_day(mins)
    assert dc.minutes[10].cls == "mismatch" and dc.minutes[10].s_q == 3
    assert dc.minutes[11].cls == "shift" and dc.minutes[11].s_q == 0


def test_negative_without_prior_candidate_is_mismatch():
    mins = day_of({10: mi(10, 5, 8, 0)})  # D = -3, davor kein Kandidat
    assert cl.classify_day(mins).minutes[10].cls == "mismatch"


def test_taker_buy_measured_separately():
    # Volumen exakt, aber Taker-Buy weicht ab -> mismatch trotz exaktem Volumen
    mins = day_of({10: mi(10, 10, 10, 0, ours_b=4, kl_b=5)})
    assert cl.classify_day(mins).minutes[10].cls == "mismatch"


def test_carry_across_days_into_minute0():
    mins = day_of({0: mi(0, 10, 18, 0)})  # D = -8; s(-1) = 8 aus dem Vortag
    ok = cl.classify_day(mins, carry_in=(8, 8), cand_prev_last=(20, 20))
    assert ok.minutes[0].cls == "shift" and ok.carry_in == (8, 8)
    bad = cl.classify_day(mins, carry_in=(0, 0), cand_prev_last=(20, 20))
    assert bad.minutes[0].cls == "mismatch"


@pytest.mark.parametrize("kl", [0, 9])
def test_missing_both_directions(kl):
    mins = day_of({10: mi(10, 9 if kl == 0 else 0, kl)})
    dc = cl.classify_day(mins)
    assert dc.minutes[10].cls == "missing"
