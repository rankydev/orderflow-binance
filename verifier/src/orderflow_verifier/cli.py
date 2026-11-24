"""Kommandozeile des Verifiers (``python -m orderflow_verifier``)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import files as fl
from .units import symbol_spec
from .verify import verify_day


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--sym", "--symbol", dest="sym", required=True)
    p.add_argument("--day", required=True, help="UTC-Tag YYYY-MM-DD")
    p.add_argument("--data-dir", type=Path, default=fl.DEFAULT_ROOT, help=".../futures/um")
    p.add_argument("--sym-id", type=int, default=None, help="sym_id für die Digests (Standard 1/2)")
    p.add_argument("--prefer", choices=["auto", "daily", "monthly"], default="auto")
    p.add_argument("--work-dir", type=Path, default=None, help="DuckDB-Spill-Verzeichnis")
    p.add_argument("--json", type=Path, default=None, help="JSON-Ergebnis in diese Datei")
    p.add_argument("--quiet", action="store_true")


def _summary(r: dict) -> str:
    c = r["classification"]
    t = r["totals"]
    lines = [
        f"{r['symbol']} {r['day']} [{r['manifest']['origin']}] rows={r['manifest']['rows']:,} "
        f"ids={r['manifest']['first_agg_id']}..{r['manifest']['last_agg_id']} "
        f"holes={r['manifest']['agg_id_holes']} dups={r['manifest']['agg_id_dups']} "
        f"back={r['manifest']['ts_backwards']} cont={r['manifest']['continues_prev']}",
        "  minutes "
        + " ".join(f"{k}={v}" for k, v in c["counts"].items())
        + f" | exact volume {c['exact_volume_minutes']}/1440, taker-buy {c['exact_taker_buy_minutes']}/1440"
        + f" | candidates={c['candidate_aggtrades']}",
        f"  totals q: ours={r['totals_display']['q']['ours']} kline={r['totals_display']['q']['kline']}"
        f" diff={r['totals_display']['q']['diff']} s(-1)={t['q']['carry_in']} s(1439)={t['q']['carry_out']}"
        f" | b: diff={r['totals_display']['b']['diff']} identity={t['identity']} bounds={t['bounds_ok']}",
        f"  state={r['state']} day_digest={r['day_digest']}",
    ]
    for tname, v in r["tables"].items():
        lines.append(f"    {tname:12s} rows={v['rows']:>9,} {v['digest']}")
    for m in c["minutes"][:12]:
        lines.append(
            f"    minute {m['minute']:4d} {m['class']:10s} D_q={m['d_q']} D_b={m['d_b']} "
            f"cand={m['cand_q']}/{m['cand_b']} carry={m['carry_q']}/{m['carry_b']}"
        )
    if len(c["minutes"]) > 12:
        lines.append(f"    ... {len(c['minutes']) - 12} weitere Einträge (siehe JSON)")
    p = r["perf"]
    lines.append(f"  perf total={p['total_s']}s load={p['load_s']}s peak_rss={p['peak_rss_mb']} MB")
    return "\n".join(lines)


def _emit(result: dict, args: argparse.Namespace, text: str) -> None:
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, indent=1, sort_keys=False) + "\n")
    if not args.quiet:
        print(text)


def cmd_day(args: argparse.Namespace) -> int:
    sym = symbol_spec(args.sym, args.sym_id)
    result, con = verify_day(
        args.data_dir,
        sym,
        args.day,
        prefer=args.prefer,
        lookback=args.lookback,
        work_dir=args.work_dir,
        checksums=not args.no_checksum,
        all_minutes=args.all_minutes,
    )
    text = _summary(result)
    if args.deep:
        from .deepcheck import deep_check, deep_summary

        result["deep"] = deep_check(
            con,
            args.data_dir,
            sym,
            args.day,
            prefer=args.prefer,
            minute_classes=result["classification"]["minutes"],
        )
        text += "\n" + deep_summary(result["deep"])
    _emit(result, args, text)
    return 3 if result["state"] == "final_bad" else 0


def cmd_deep(args: argparse.Namespace) -> int:
    from .deepcheck import deep_check_standalone, deep_summary

    sym = symbol_spec(args.sym, args.sym_id)
    result = deep_check_standalone(
        args.data_dir, sym, args.day, prefer=args.prefer, work_dir=args.work_dir
    )
    _emit(result, args, deep_summary(result))
    return 0 if result["deep_check"] in ("passed", "reference_unusable") else 3


def cmd_db(args: argparse.Namespace) -> int:
    from .dbmode import compare_db, db_summary

    sym = symbol_spec(args.sym, args.sym_id)
    result = compare_db(
        args.data_dir,
        sym,
        args.day,
        prefer=args.prefer,
        lookback=args.lookback,
        work_dir=args.work_dir,
        limit=args.limit,
    )
    _emit(result, args, db_summary(result))
    return 0 if result["equal"] else 3


def cmd_compare(args: argparse.Namespace) -> int:
    from .compare import compare_importer, compare_summary

    result = compare_importer(args.importer_jsonl, args.verifier_json)
    _emit(result, args, compare_summary(result))
    return 0 if result["all_equal"] else 3


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="orderflow_verifier", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("day", help="Dateimodus: Tag aus Rohdateien neu berechnen")
    _common(d)
    d.add_argument("--lookback", type=int, default=2, help="Vortage für die Übertragskette")
    d.add_argument("--no-checksum", action="store_true")
    d.add_argument("--all-minutes", action="store_true", help="alle 1440 Minuten ins JSON")
    d.add_argument("--deep", action="store_true", help="zusätzlich Tiefenprüfung (trades-Dump)")
    d.set_defaults(fn=cmd_day)

    k = sub.add_parser("deep", help="Tiefenprüfung gegen den trades-Dump (KONZEPT §4.7)")
    _common(k)
    k.set_defaults(fn=cmd_deep)

    b = sub.add_parser("db", help="Datenbankmodus (UNGETESTET, keine Datenbank vorhanden)")
    _common(b)
    b.add_argument("--lookback", type=int, default=2)
    b.add_argument(
        "--limit", type=int, default=5, help="Anzahl gemeldeter Differenzzeilen je Tabelle"
    )
    b.set_defaults(fn=cmd_db)

    c = sub.add_parser("compare", help="Verifier-JSON mit Importer-Dry-Run (jsonl) vergleichen")
    c.add_argument("importer_jsonl", type=Path)
    c.add_argument("verifier_json", type=Path, nargs="+")
    c.add_argument("--json", type=Path, default=None)
    c.add_argument("--quiet", action="store_true")
    c.set_defaults(fn=cmd_compare)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.fn(args)
    except (FileNotFoundError, ValueError, RuntimeError) as exc:
        print(f"Fehler: {exc}", file=sys.stderr)
        return 2
