"""Tiefenprüfung, Datenbank-Diff (mit DuckDB-Ersatz) und Importer-Vergleich an der synthetischen Welt."""

import json

import duckdb

import world as w
from orderflow_verifier import dbmode, deepcheck
from orderflow_verifier import recompute as rc
from orderflow_verifier.compare import compare_importer
from orderflow_verifier.units import DIGEST_TABLES, symbol_spec
from orderflow_verifier.verify import verify_day

SPEC = symbol_spec("BTCUSDT")
DAY = w.D.isoformat()


def deep(root, **kw):
    res, con = verify_day(root, SPEC, DAY, checksums=False)
    return deepcheck.deep_check(
        con, root, SPEC, DAY, minute_classes=res["classification"]["minutes"], **kw
    )


def test_deep_check_passes_on_complete_dump(tmp_path):
    root = w.build_world(tmp_path, trades=True)
    r = deep(root)
    assert r["deep_check"] == "passed", r["failures"]
    assert len(r["usable_hours"]) == 24
    assert r["straddling_aggtrades"] == 2  # Agg 56 (Minute 1->2) und Agg 62 (Minute 1439->Folgetag)
    assert r["shifted_minutes"] == 3  # s(m) != 0 in Minute 1, 1439 und s(-1) (Agg 50 -> Minute -1)
    assert r["step3"]["minutes_checked"] == 1440
    assert r["step4"]["minute_1439_checked"] is True
    assert r["step5"]["level_mismatches"] == 0


def test_deep_check_incomplete_hour_is_reference_unusable(tmp_path):
    root = w.build_world(tmp_path, trades=True)
    # eine Zeile aus dem Dump der Stunde 0 entfernen (Fill id 111 = Agg 58, 40 Lots)
    import zipfile

    p = root / f"daily/trades/{w.SYM}/{w.SYM}-trades-{DAY}.zip"
    with zipfile.ZipFile(p) as z:
        name = z.namelist()[0]
        text = z.read(name).decode()
    lines = [ln for ln in text.splitlines() if not ln.startswith("111,")]
    with zipfile.ZipFile(p, "w") as z:
        z.writestr(name, "\n".join(lines) + "\n")
    r = deep(root)
    assert r["deep_check"] == "reference_unusable"
    assert r["unusable_hours"] == [0]
    assert r["usable_hours_result"] == "passed"  # alle übrigen Stunden stimmen


def test_deep_check_detects_real_error_in_usable_hour(tmp_path):
    # Kline-Abweichung in Stunde 0 bei vollständigem Dump: Stunde bleibt brauchbar nicht (Σ ≠), aber
    # ein Fehler in unseren Tabellen wird erkannt: Minute 6 Kline um 1 Lot verändert -> Stunde 0 unbrauchbar
    root = w.build_world(tmp_path, trades=True, bad=True)
    r = deep(root)
    assert r["deep_check"] == "reference_unusable"  # Dump ist die Wahrheit, Klines weichen ab


def test_db_diff_reports_first_differing_rows():
    con = duckdb.connect()
    cols = "ts BIGINT, px BIGINT, buy_q BIGINT, sell_q BIGINT, buy_a BIGINT, sell_a BIGINT"
    con.execute(f"CREATE TABLE fp_1m ({cols})")
    con.execute(f"CREATE TABLE db_fp_1m ({cols})")
    con.execute("INSERT INTO fp_1m VALUES (0,100,1,2,1,1),(0,101,3,0,1,0),(60000,100,5,5,1,1)")
    con.execute("INSERT INTO db_fp_1m VALUES (0,100,1,2,1,1),(0,101,4,0,1,0),(60000,102,9,9,1,1)")
    d = dbmode.diff_table(con, "fp_1m", "db_fp_1m", limit=10)
    assert d["differing_rows"] == 3
    kinds = [(e["ts"], e["px"], e["kind"]) for e in d["first"]]
    assert kinds == [
        (0, 101, "column_differences"),
        (60000, 100, "only_in_recomputation"),
        (60000, 102, "only_in_database"),
    ]
    assert d["first"][0]["columns"] == {"buy_q": {"mine": 3, "db": 4}}


class FakeDb:
    """Ersatz-Datenbank: kopiert die berechneten Tabellen in eine zweite DuckDB (optional manipuliert)."""

    def __init__(self, con, spec, result, corrupt=None):
        self.con, self.spec, self.result = con, spec, result
        self.store = duckdb.connect()
        for t in DIGEST_TABLES:
            self.store.register(f"src_{t}", con.cursor().sql(f"SELECT * FROM {t}").to_arrow_table())
            self.store.execute(f"CREATE TABLE {t} AS SELECT * FROM src_{t}")
        if corrupt:
            self.store.execute(corrupt)

    def symbol_row(self, name):
        s = self.spec
        return {
            "sym_id": s.sym_id,
            "price_decimals": s.price_decimals,
            "qty_decimals": s.qty_decimals,
            "tick_ref_units": s.tick_ref_units,
        }

    def server_digest(self, table, sym_id, day):
        return rc.table_digest(self.store, table, sym_id)[0]

    def server_digest_all(self, sym_id, day):
        return rc.combine_digests({t: self.server_digest(t, sym_id, day) for t in DIGEST_TABLES})

    def load_table(self, con, table, sym_id, day, into):
        stored = self.store.cursor().sql(f"SELECT * FROM {table}").to_arrow_table()  # noqa: F841
        con.execute(f"CREATE OR REPLACE TABLE {into} AS SELECT * FROM stored")

    def rows(self, sql, params):
        r, c = self.result, self.result["classification"]
        n, m = c["counts"], r["manifest"]
        if "FROM data_day" in sql:
            return [
                {
                    "state": r["state"],
                    "digest": r["day_digest"],
                    "rows": m["rows"],
                    "first_agg_id": m["first_agg_id"],
                    "last_agg_id": m["last_agg_id"],
                    "min_exact": n["exact"],
                    "min_shift": n["shift"],
                    "min_mismatch": n["mismatch"],
                    "min_missing": n["missing"],
                    "edge_pending": n["edge_pending"] > 0,
                }
            ]
        if "FROM data_minute_issue" in sql:
            keys = ("d_q", "d_b", "cand_q", "cand_b", "carry_q", "carry_b")
            return [
                {"ts": x["ts"], "kind": x["class"], **{k: x[k] for k in keys}}
                for x in c["minutes"]
                if x["class"] in ("shift", "mismatch", "missing")
            ]
        if "FROM bar_1m" in sql:
            code = {"exact": 1, "shift": 2, "mismatch": 3}
            cls = {x["ts"]: x["class"] for x in c["minutes"]}
            stored = self.store.execute("SELECT ts FROM bar_1m ORDER BY ts").fetchall()
            return [
                {"ts": ts, "check_state": code.get(cls.get(ts, "exact"), 1)} for (ts,) in stored
            ]
        if "FROM raw_day" in sql:
            keys = ("rows", "first_agg_id", "last_agg_id", "agg_id_holes", "agg_id_dups")
            return [{k: m[k] for k in (*keys, "ts_backwards", "continues_prev")}]
        raise AssertionError(sql)


def make_fake(tmp_path, corrupt=None):
    root = w.build_world(tmp_path)
    res, con = verify_day(root, SPEC, DAY, checksums=False)
    return FakeDb(con, SPEC, res, corrupt), res, con


def test_db_compare_equal_when_identical(tmp_path):
    fx, res, con = make_fake(tmp_path)
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert out["equal"], out
    assert all(t["equal"] for t in out["tables"].values())


def test_db_compare_reports_corrupted_rollup_row(tmp_path):
    fx, res, con = make_fake(tmp_path, "UPDATE fp_15m_b100 SET buy_q = buy_q + 1")
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    assert not out["equal"]
    assert [t for t, v in out["tables"].items() if not v["equal"]] == ["fp_15m_b100"]
    first = out["tables"]["fp_15m_b100"]["first"][0]
    assert first["kind"] == "column_differences"
    assert first["columns"] == {"buy_q": {"mine": 188, "db": 189}}
    assert out["day_digest"]["equal"] is False


def test_db_compare_reports_missing_bar_row(tmp_path):
    fx, res, con = make_fake(tmp_path, f"DELETE FROM bar_1m WHERE ts = {w.D0 + 7 * 60000}")
    out = dbmode.compare_with_fetcher(fx, con, SPEC, res, DAY)
    e = out["tables"]["bar_1m"]["first"][0]
    assert e["kind"] == "only_in_recomputation" and e["ts"] == w.D0 + 7 * 60000


def test_compare_importer_fields(tmp_path):
    root = w.build_world(tmp_path)
    res, _ = verify_day(root, SPEC, DAY, checksums=False)
    c = res["classification"]
    im = {
        "symbol": "BTCUSDT",
        "day": DAY,
        "digest": res["day_digest"],
        "digests": {t: res["tables"][t]["digest"] for t in DIGEST_TABLES},
        "counts": c["counts"],
        "exactQ": c["exact_volume_minutes"],
        "exactB": c["exact_taker_buy_minutes"],
        "candidates": c["candidate_aggtrades"],
        "carryIn": c["carry_in"],
        "carryOut": c["carry_out"],
        "totals": {
            "ourQ": res["totals"]["q"]["ours"],
            "klQ": res["totals"]["q"]["kline"],
            "ourB": res["totals"]["b"]["ours"],
            "klB": res["totals"]["b"]["kline"],
            "identityQ": True,
            "identityB": True,
            "carryBoundsOk": True,
        },
        "rows": res["manifest"]["rows"],
        "firstAggId": 51,
        "lastAggId": 62,
        "aggIdHoles": 0,
        "continuesPrev": True,
        "state": "final_ok",
        "issues": [],
        "edges": [
            {
                "minute": e["minute"],
                "cls": e["class"],
                "dQ": e["d_q"],
                "dB": e["d_b"],
                "candQ": e["cand_q"],
                "candB": e["cand_b"],
                "sQ": e["carry_q"],
                "sB": e["carry_b"],
            }
            for e in c["edges"]
        ],
        "fpRows": {t: res["tables"][t]["rows"] for t in DIGEST_TABLES[:8]},
        "bars": res["tables"]["bar_1m"]["rows"],
        "ohlc": {k: res["ohlc"][k] for k in ("compared", "open", "high", "low", "close")},
    }
    jl = tmp_path / "imp.jsonl"
    vj = tmp_path / "v.json"
    jl.write_text(json.dumps(im) + "\n")
    vj.write_text(json.dumps(res))
    assert compare_importer(jl, [vj])["all_equal"] is True
    im["digests"]["bar_1h"] = "0" * 64
    jl.write_text(json.dumps(im) + "\n")
    out = compare_importer(jl, [vj])
    assert out["all_equal"] is False
    assert out["days"][0]["differences"][0]["field"] == "digest.bar_1h"
