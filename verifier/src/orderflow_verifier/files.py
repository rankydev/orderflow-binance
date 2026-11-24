"""Auffinden, Prüfen und Laden der Rohdateien (nur lesend) in DuckDB-Tabellen.

Alle Dezimalwerte werden beim Laden als Text gelesen und per SQL exakt in Ganzzahlen umgewandelt
(units.dec_int_sql). Eine fehlende Kopfzeile wird erkannt (erstes Feld nicht rein numerisch).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import zipfile
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.csv as pacsv

from .rawzip import single_member
from .units import MS_DAY, SymbolSpec, dec_int_sql

AGG_COLUMNS = (
    "agg_trade_id",
    "price",
    "quantity",
    "first_trade_id",
    "last_trade_id",
    "transact_time",
    "is_buyer_maker",
)
KLINE_COLUMNS = (
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "count",
    "taker_buy_volume",
    "taker_buy_quote_volume",
    "ignore",
)
TRADE_COLUMNS = ("id", "price", "qty", "quote_qty", "time", "is_buyer_maker")

_INT_COLS = {
    "agg": {"agg_trade_id", "first_trade_id", "last_trade_id", "transact_time"},
    "kline": {"open_time", "close_time", "count"},
    "trade": {"id", "time"},
}

DEFAULT_ROOT = Path(__file__).resolve().parents[3] / "data/raw/binance-vision/futures/um"


def day_to_ms(day: str | dt.date) -> int:
    d = dt.date.fromisoformat(day) if isinstance(day, str) else day
    return (d - dt.date(1970, 1, 1)).days * MS_DAY


def add_days(day: str | dt.date, n: int) -> dt.date:
    d = dt.date.fromisoformat(day) if isinstance(day, str) else day
    return d + dt.timedelta(days=n)


@dataclass(frozen=True)
class RawFile:
    kind: str  # aggTrades | klines | trades
    origin: str  # daily | monthly
    path: Path
    period: str  # YYYY-MM-DD bzw. YYYY-MM


def locate(root: Path, kind: str, sym: str, day: dt.date, prefer: str = "auto") -> RawFile | None:
    """Datei für (kind, Symbol, Tag). Tagesdatei bevorzugt, sonst Monatsdatei (nur aggTrades)."""
    d = day.isoformat()
    if kind == "aggTrades":
        daily = root / f"daily/aggTrades/{sym}/{sym}-aggTrades-{d}.zip"
        monthly = root / f"monthly/aggTrades/{sym}/{sym}-aggTrades-{d[:7]}.zip"
        order = {
            "auto": ("daily", "monthly"),
            "daily": ("daily",),
            "monthly": ("monthly",),
        }[prefer]
        for origin in order:
            p, per = (daily, d) if origin == "daily" else (monthly, d[:7])
            if p.exists():
                return RawFile(kind, origin, p, per)
        return None
    if kind == "klines":
        p = root / f"daily/klines/{sym}/1m/{sym}-1m-{d}.zip"
        return RawFile(kind, "daily", p, d) if p.exists() else None
    if kind == "trades":
        p = root / f"daily/trades/{sym}/{sym}-trades-{d}.zip"
        return RawFile(kind, "daily", p, d) if p.exists() else None
    raise ValueError(kind)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 22):
            h.update(chunk)
    return h.hexdigest()


def checksum_status(path: Path) -> dict:
    """SHA256 der Datei gegen den Inhalt der Schwesterdatei .CHECKSUM."""
    sidecar = path.with_name(path.name + ".CHECKSUM")
    actual = sha256_file(path)
    expected = None
    if sidecar.exists():
        parts = sidecar.read_text().split()
        expected = parts[0].lower() if parts else None
    return {
        "file": path.name,
        "bytes": path.stat().st_size,
        "sha256": actual,
        "expected": expected,
        "ok": expected is not None and expected == actual,
    }


def _peek_header(path: Path, member: str) -> bool:
    """True, wenn die erste Zeile eine Kopfzeile ist (erstes Feld nicht rein numerisch)."""
    with zipfile.ZipFile(path) as z, z.open(member) as fh:
        first = fh.readline().decode("ascii", "replace").strip()
    return not first.split(",")[0].strip().isdigit()


def _reader(path: Path, columns: tuple[str, ...], int_cols: set[str]):
    """Streamender pyarrow-Leser, der Zahlenspalten als Text und nur IDs/Zeiten als int64 liest."""
    z = zipfile.ZipFile(path, "r")
    member = single_member(z)
    header = _peek_header(path, member)
    fh = z.open(member, "r")
    reader = pacsv.open_csv(
        fh,
        read_options=pacsv.ReadOptions(
            column_names=list(columns), skip_rows=1 if header else 0, block_size=1 << 25
        ),
        convert_options=pacsv.ConvertOptions(
            column_types={c: (pa.int64() if c in int_cols else pa.string()) for c in columns},
            strings_can_be_null=False,
        ),
    )

    def close():
        fh.close()
        z.close()

    return reader, header, close


def _check_ms(con: duckdb.DuckDBPyConnection, table: str, col: str) -> None:
    bad = con.execute(
        f"SELECT count(*) FROM {table} WHERE {col} < 1000000000000 OR {col} > 9999999999999"
    ).fetchone()[0]
    if bad:
        raise ValueError(f"{table}: {bad} Zeitstempel ohne 13 Stellen (kein ms-Format)")


def _bool_sql(col: str) -> str:
    return (
        f"(CASE lower({col}) WHEN 'true' THEN true WHEN 'false' THEN false "
        f"ELSE error('ungueltiges is_buyer_maker: ' || {col}) END)"
    )


def create_agg_table(con: duckdb.DuckDBPyConnection, table: str = "agg") -> None:
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {table} (src VARCHAR, id BIGINT, px BIGINT, q BIGINT, "
        "f BIGINT, l BIGINT, t BIGINT, m BOOLEAN)"
    )


def load_aggtrades(
    con: duckdb.DuckDBPyConnection,
    spec: SymbolSpec,
    rf: RawFile,
    windows: list[tuple[int, int]] | None = None,
    table: str = "agg",
) -> dict:
    """Lädt eine aggTrades-Datei exakt geparst in ``table`` (nur Zeilen in einem der Zeitfenster).

    Gibt Dateikennzahlen zurück: Zeilen der Datei, Kopfzeile ja/nein, geladene Zeilen.
    """
    create_agg_table(con, table)
    reader, header, close = _reader(rf.path, AGG_COLUMNS, _INT_COLS["agg"])
    try:
        con.register("rd_stream", reader)
        where = ""
        if windows:
            where = "WHERE " + " OR ".join(
                f"(transact_time >= {lo} AND transact_time < {hi})" for lo, hi in windows
            )
        before = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        con.execute(
            f"""INSERT INTO {table}
            SELECT '{rf.period}', agg_trade_id,
                   {dec_int_sql("price", spec.price_decimals)},
                   {dec_int_sql("quantity", spec.qty_decimals)},
                   first_trade_id, last_trade_id, transact_time,
                   {_bool_sql("is_buyer_maker")}
            FROM rd_stream {where}"""
        )
    finally:
        con.unregister("rd_stream")
        close()
    after = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    return {"header_present": header, "rows_loaded": after - before}


def load_aggtrades_days(
    con: duckdb.DuckDBPyConnection,
    spec: SymbolSpec,
    root: Path,
    days: list[dt.date],
    prefer: str = "auto",
    clip: dict[dt.date, tuple[int, int]] | None = None,
    table: str = "agg",
) -> dict[dt.date, dict]:
    """Lädt aggTrades für mehrere Tage; Monatsdateien werden nur einmal durchlaufen.

    ``clip[day]`` = (t_from, t_to) in ms begrenzt einen Tag auf einen Ausschnitt (Nachbartage).
    Rückgabe: je Tag Quelle und Dateikennzahlen (fehlende Tage fehlen im Ergebnis).
    """
    info: dict[dt.date, dict] = {}
    by_file: dict[Path, list[dt.date]] = {}
    files: dict[dt.date, RawFile] = {}
    for d in days:
        rf = locate(root, "aggTrades", spec.name, d, prefer)
        if rf is None:
            continue
        files[d] = rf
        by_file.setdefault(rf.path, []).append(d)
    for path, ds in by_file.items():
        rf = files[ds[0]]
        windows = [(clip or {}).get(d) or (day_to_ms(d), day_to_ms(d) + MS_DAY) for d in ds]
        if rf.origin == "daily":
            # Tagesdatei: ohne Zeitfilter laden, damit Zeilen außerhalb des Tages sichtbar werden.
            window = (clip or {}).get(ds[0])
            res = load_aggtrades(con, spec, rf, [window] if window else None)
            info[ds[0]] = {"origin": "daily", "path": str(path), **res}
        else:
            res = load_aggtrades(con, spec, rf, windows)
            for d in ds:
                info[d] = {"origin": "monthly", "path": str(path), **res}
    _check_ms(con, table, "t")
    return info


def load_klines(
    con: duckdb.DuckDBPyConnection, spec: SymbolSpec, rf: RawFile, table: str = "kl"
) -> dict:
    """Lädt eine Kline-Tagesdatei exakt geparst (Preise, Mengen, Notional als Ganzzahlen)."""
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {table} (ts BIGINT, open_px BIGINT, high_px BIGINT, "
        "low_px BIGINT, close_px BIGINT, vol BIGINT, taker_buy BIGINT, trades BIGINT, "
        "quote_vol_n BIGINT)"
    )
    reader, header, close = _reader(rf.path, KLINE_COLUMNS, _INT_COLS["kline"])
    try:
        con.register("rd_stream", reader)
        p, qd, nd = spec.price_decimals, spec.qty_decimals, spec.notional_decimals
        con.execute(
            f"""INSERT INTO {table}
            SELECT open_time, {dec_int_sql("open", p)}, {dec_int_sql("high", p)},
                   {dec_int_sql("low", p)}, {dec_int_sql("close", p)},
                   {dec_int_sql("volume", qd)}, {dec_int_sql("taker_buy_volume", qd)},
                   count, {dec_int_sql("quote_volume", nd)}
            FROM rd_stream"""
        )
    finally:
        con.unregister("rd_stream")
        close()
    _check_ms(con, table, "ts")
    return {"header_present": header, "path": str(rf.path)}


def load_trades(
    con: duckdb.DuckDBPyConnection,
    spec: SymbolSpec,
    rf: RawFile,
    table: str = "tr",
    t_to: int | None = None,
) -> dict:
    """Lädt einen trades-Dump (Einzelfills) exakt geparst."""
    con.execute(
        f"CREATE TABLE IF NOT EXISTS {table} (id BIGINT, px BIGINT, q BIGINT, t BIGINT, m BOOLEAN)"
    )
    reader, header, close = _reader(rf.path, TRADE_COLUMNS, _INT_COLS["trade"])
    try:
        con.register("rd_stream", reader)
        con.execute(
            f"""INSERT INTO {table}
            SELECT id, {dec_int_sql("price", spec.price_decimals)},
                   {dec_int_sql("qty", spec.qty_decimals)}, time, {_bool_sql("is_buyer_maker")}
            FROM rd_stream {"WHERE time < " + str(t_to) if t_to is not None else ""}"""
        )
    finally:
        con.unregister("rd_stream")
        close()
    _check_ms(con, table, "t")
    return {"header_present": header, "path": str(rf.path)}
