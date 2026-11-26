"""Einheiten, Symbolparameter und exakte Dezimal-zu-Ganzzahl-Umwandlung (KONZEPT §3.2, §4.4).

Alles, was Preis oder Menge betrifft, läuft über Zeichenketten und Ganzzahlen, nie über Gleitkomma.
Die Umwandlung geschieht als SQL-Ausdruck in DuckDB (eine Spalte als Text in, BIGINT out).
"""

from __future__ import annotations

from dataclasses import dataclass

MS_MIN = 60_000
MS_HOUR = 3_600_000
MS_DAY = 86_400_000
INT32_MAX = 2**31 - 1


@dataclass(frozen=True)
class SymbolSpec:
    """Parameter aus KONZEPT §3.2: BTC price_unit 0.01 / ETH 0.001, qty_unit 0.001, Tick 10 Einheiten."""

    name: str
    sym_id: int
    price_decimals: int
    qty_decimals: int
    tick_ref_units: int = 10

    @property
    def notional_decimals(self) -> int:
        return self.price_decimals + self.qty_decimals


# sym_id ist in den Digests enthalten. Das Konzept legt keine Nummern fest; Standard 1/2 in der
# Reihenfolge BTC, ETH (per --sym-id überschreibbar, im DB-Modus aus der Tabelle `symbol` gelesen).
SYMBOLS: dict[str, SymbolSpec] = {
    "BTCUSDT": SymbolSpec("BTCUSDT", 1, 2, 3),
    "ETHUSDT": SymbolSpec("ETHUSDT", 2, 3, 3),
}


def symbol_spec(name: str, sym_id: int | None = None) -> SymbolSpec:
    try:
        base = SYMBOLS[name]
    except KeyError as exc:
        raise ValueError(f"unbekanntes Symbol {name!r}; bekannt: {sorted(SYMBOLS)}") from exc
    if sym_id is None:
        return base
    return SymbolSpec(
        base.name, sym_id, base.price_decimals, base.qty_decimals, base.tick_ref_units
    )


@dataclass(frozen=True)
class RollupDef:
    table: str
    bucket_ms: int
    bin_ticks: int


# KONZEPT §3.6; Reihenfolge wie in day_digest_all (Migration 0005).
ROLLUPS: tuple[RollupDef, ...] = (
    RollupDef("fp_1m_b10", MS_MIN, 10),
    RollupDef("fp_5m_b10", 5 * MS_MIN, 10),
    RollupDef("fp_15m_b100", 15 * MS_MIN, 100),
    RollupDef("fp_1h_b10", MS_HOUR, 10),
    RollupDef("fp_1h_b100", MS_HOUR, 100),
    RollupDef("fp_1d_b100", MS_DAY, 100),
    RollupDef("fp_1d_b1000", MS_DAY, 1000),
)

FP_TABLES = ("fp_1m",) + tuple(r.table for r in ROLLUPS)
# Digest-Teile je Version (data_day.digest_version, Migration 0017, SQL day_digest_all_v):
# Version 1 = Liste aus 0005 (zwölf Tabellen bis P4); Version 2 = zusätzlich big_order und die
# Ordersummen des Tages (order_day: sym_id, day, orders_n, orders_notional, big_floor_n).
DIGEST_TABLES_V1 = (*FP_TABLES, "bar_1m", "bar_1h", "bar_1d", "kline_1m")
# Tabellen eines Tages in der aktuellen Version (order_day ist keine Tabelle, sondern eine Zeile
# von data_day und kommt nur im kombinierten Digest vor).
DIGEST_TABLES = (*DIGEST_TABLES_V1, "big_order")
DIGEST_TABLES_V2 = (*DIGEST_TABLES, "order_day")
DIGEST_PARTS = {1: DIGEST_TABLES_V1, 2: DIGEST_TABLES_V2}
DIGEST_VERSION = 2
# Order-Regel v1 (KONZEPT §3.7): maximaler Lauf gleicher ms, gleicher Seite, aggId lückenlos +1.
ORDER_RULE_VERSION = 1


def dec_int_sql(col: str, decimals: int) -> str:
    """SQL-Ausdruck: Dezimalstring ``col`` -> BIGINT in Einheiten 10^-decimals (KONZEPT §4.4).

    Nachkommateil wird mit Nullen aufgefüllt; mehr Stellen als ``decimals`` sind nur zulässig,
    wenn die überzähligen Stellen ``0`` sind, sonst bricht die Abfrage mit einem Fehler ab.
    Vorzeichen, Exponenten, Leerzeichen und leere Teile werden abgelehnt.
    """
    c = f"({col})"
    frac = f"split_part({c}, '.', 2)"
    ok = (
        f"regexp_full_match({c}, '[0-9]+(\\.[0-9]+)?') "
        f"AND regexp_full_match(substr({frac}, {decimals + 1}), '0*')"
    )
    val = f"CAST(split_part({c}, '.', 1) || rpad(substr({frac}, 1, {decimals}), {decimals}, '0') AS BIGINT)"
    return f"(CASE WHEN {ok} THEN {val} ELSE error('ungueltige Dezimalzahl: ' || {c}) END)"


def lots_to_str(lots: int, decimals: int) -> str:
    """Ganzzahl in Einheiten 10^-decimals als exakter Dezimalstring (nur zur Anzeige)."""
    sign = "-" if lots < 0 else ""
    n = abs(lots)
    if decimals == 0:
        return f"{sign}{n}"
    s = str(n).rjust(decimals + 1, "0")
    return f"{sign}{s[:-decimals]}.{s[-decimals:]}"
