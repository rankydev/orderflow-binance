"""Vergleich der Verifier-Ergebnisse mit der Trockenlauf-Ausgabe (jsonl) des Importers.

Der Importer wird nur über seine dokumentierte Ausgabe (``--out ergebnis.jsonl``) gelesen; sein
Quelltext wird nicht benutzt. Felder werden nach Namen zugeordnet; fehlende Felder werden gemeldet.
"""

from __future__ import annotations

import json
from pathlib import Path

from .units import DIGEST_PARTS, FP_TABLES


def _load_jsonl(path: Path) -> dict[tuple[str, str], dict]:
    out = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith("{"):
            r = json.loads(line)
            out[(r["symbol"], r["day"])] = r
    return out


def _cmp(name: str, mine, theirs, rows: list[dict]) -> None:
    rows.append({"field": name, "verifier": mine, "importer": theirs, "equal": mine == theirs})


def compare_one(v: dict, im: dict) -> dict:
    rows: list[dict] = []
    # Digest-Version der Importer-Zeile (Zeilen vor Migration 0017 tragen keine: Version 1)
    version = int(im.get("digestVersion", 1))
    _cmp("digest_version_known", version in DIGEST_PARTS, True, rows)
    for t in DIGEST_PARTS.get(version, ()):
        _cmp(f"digest.{t}", v["tables"][t]["digest"], im.get("digests", {}).get(t), rows)
    _cmp(f"day_digest.v{version}", v["day_digests"].get(str(version)), im.get("digest"), rows)
    if version >= 2:
        o, io = v["orders"], im.get("orders", {})
        # Notional als Dezimalstring im Importer-JSON (Tagessummen > 2^53)
        _cmp("orders.n", o["orders_n"], io.get("n"), rows)
        _cmp("orders.notional", str(o["orders_notional"]), io.get("notional"), rows)
        _cmp("orders.bars_notional", str(o["bars_notional"]), io.get("barsNotional"), rows)
        _cmp("orders.big", o["big_orders"], io.get("big"), rows)
        _cmp("orders.big_floor_n", o["big_floor_n"], io.get("bigFloorN"), rows)
        _cmp("orders.reconciled", o["reconciled"], True, rows)
    c = v["classification"]
    for k in ("exact", "shift", "mismatch", "missing", "edge_pending"):
        _cmp(f"class.{k}", c["counts"][k], im.get("counts", {}).get(k), rows)
    _cmp("exact_volume_minutes", c["exact_volume_minutes"], im.get("exactQ"), rows)
    _cmp("exact_taker_buy_minutes", c["exact_taker_buy_minutes"], im.get("exactB"), rows)
    _cmp("candidate_aggtrades", c["candidate_aggtrades"], im.get("candidates"), rows)
    t = v["totals"]
    it = im.get("totals", {})
    _cmp("totals.ours_q", t["q"]["ours"], it.get("ourQ"), rows)
    _cmp("totals.kline_q", t["q"]["kline"], it.get("klQ"), rows)
    _cmp("totals.ours_b", t["b"]["ours"], it.get("ourB"), rows)
    _cmp("totals.kline_b", t["b"]["kline"], it.get("klB"), rows)
    _cmp("totals.identity", t["identity"], it.get("identityQ") and it.get("identityB"), rows)
    _cmp("totals.bounds_ok", t["bounds_ok"], it.get("carryBoundsOk"), rows)
    _cmp("carry_in", c["carry_in"], im.get("carryIn"), rows)
    _cmp("carry_out", c["carry_out"], im.get("carryOut"), rows)
    m = v["manifest"]
    _cmp("rows", m["rows"], im.get("rows"), rows)
    _cmp("first_agg_id", m["first_agg_id"], im.get("firstAggId"), rows)
    _cmp("last_agg_id", m["last_agg_id"], im.get("lastAggId"), rows)
    _cmp("agg_id_holes", m["agg_id_holes"], im.get("aggIdHoles"), rows)
    _cmp("continues_prev", m["continues_prev"], im.get("continuesPrev"), rows)
    fp = im.get("fpRows", {})
    for tname in FP_TABLES:
        _cmp(f"rows.{tname}", v["tables"][tname]["rows"], fp.get(tname), rows)
    _cmp("rows.bar_1m", v["tables"]["bar_1m"]["rows"], im.get("bars"), rows)
    o, io = v["ohlc"], im.get("ohlc", {})
    for k in ("compared", "open", "high", "low", "close"):
        _cmp(f"ohlc.{k}", o[k], io.get(k), rows)
    _cmp("state", v["state"], im.get("state"), rows)
    mine_issues = sorted(
        (x["minute"], x["class"]) for x in c["minutes"] if x["class"] in ("mismatch", "missing")
    )
    _cmp("n_mismatch_missing_minutes", len(mine_issues), len(im.get("issues", [])), rows)
    # Einzelheiten je Problemminute und die beiden Randminuten (Beträge in Lots, Übertrag begrenzt)
    keys = ("minute", "class", "d_q", "d_b", "cand_q", "cand_b", "carry_q", "carry_b")
    mine_detail = sorted(
        tuple(x[k] for k in keys) for x in c["minutes"] if x["class"] in ("mismatch", "missing")
    )
    imp_detail = sorted(
        (i["minute"], i["cls"], i["dQ"], i["dB"], i["candQ"], i["candB"], i["sQ"], i["sB"])
        for i in im.get("issues", [])
    )
    _cmp("issue_details", mine_detail, imp_detail, rows)
    mine_edges = [tuple(e[k] for k in keys) for e in c["edges"]]
    imp_edges = [
        (e["minute"], e["cls"], e["dQ"], e["dB"], e["candQ"], e["candB"], e["sQ"], e["sB"])
        for e in im.get("edges", [])
    ]
    _cmp("edge_minutes", mine_edges, imp_edges, rows)
    bad = [r for r in rows if not r["equal"]]
    return {
        "symbol": v["symbol"],
        "day": v["day"],
        "equal": not bad,
        "compared": len(rows),
        "differences": bad,
    }


def compare_importer(importer_jsonl: Path, verifier_jsons: list[Path]) -> dict:
    imp = _load_jsonl(importer_jsonl)
    days = []
    for p in verifier_jsons:
        v = json.loads(Path(p).read_text())
        key = (v["symbol"], v["day"])
        if key not in imp:
            days.append(
                {"symbol": key[0], "day": key[1], "equal": False, "missing_in_importer": True}
            )
            continue
        days.append(compare_one(v, imp[key]))
    return {"all_equal": all(d["equal"] for d in days), "days": days}


def compare_summary(r: dict) -> str:
    lines = []
    for d in r["days"]:
        if d.get("missing_in_importer"):
            lines.append(f"{d['symbol']} {d['day']}: nicht in der Importer-Ausgabe")
            continue
        lines.append(
            f"{d['symbol']} {d['day']}: {'GLEICH' if d['equal'] else 'ABWEICHUNG'} "
            f"({d['compared']} Felder verglichen)"
        )
        for x in d["differences"]:
            lines.append(f"    {x['field']}: verifier={x['verifier']} importer={x['importer']}")
    lines.append("alle gleich" if r["all_equal"] else "ES GIBT ABWEICHUNGEN")
    return "\n".join(lines)
