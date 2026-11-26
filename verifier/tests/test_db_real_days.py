"""Opt-in (OF_VERIFIER_DB=1): Datenbankmodus gegen eine echte, vom Importer geschriebene Datenbank.

Nur lesend. Verbindung über OF_DB_HOST/OF_DB_PORT/OF_DB_USER/OF_DB_PASSWORD/OF_DB_NAME (eine
Wegwerf-Datenbank verwenden), Rohdaten unter OF_VERIFIER_DATA_ROOT (Standard data/ im Repo), Tage
als OF_VERIFIER_DB_DAYS="BTCUSDT:2026-11-21,ETHUSDT:2026-11-21". Jeder Tag muss in der Version seines
gespeicherten Digests bitgleich übereinstimmen; ein Tag mit Version 2 muss big orders haben, wenn
seine Untergrenze gesetzt ist.
"""

import os
from pathlib import Path

import pytest

from orderflow_verifier.dbmode import PgFetcher, compare_db
from orderflow_verifier.files import DEFAULT_ROOT
from orderflow_verifier.units import symbol_spec

pytestmark = pytest.mark.db

DAYS = [
    tuple(x.split(":"))
    for x in os.environ.get("OF_VERIFIER_DB_DAYS", "BTCUSDT:2026-11-21,ETHUSDT:2026-11-21").split(
        ","
    )
]
ROOT = Path(os.environ.get("OF_VERIFIER_DATA_ROOT", str(DEFAULT_ROOT)))


@pytest.mark.parametrize(("sym", "day"), DAYS)
def test_real_day_matches_database_bit_exactly(sym, day):
    fx = PgFetcher()
    stored = fx.rows(
        "SELECT d.digest_version, d.big_floor_n FROM data_day d JOIN symbol s USING (sym_id) "
        "WHERE s.name = %s AND d.day = %s::date",
        (sym, day),
    )
    assert stored, f"{sym} {day} fehlt in data_day"
    out = compare_db(ROOT, symbol_spec(sym), day, fetcher=fx)
    bad = {t: v for t, v in out["tables"].items() if not v["equal"]}
    assert out["equal"], (bad, out["quality"]["checks"])
    assert out["verified_version"] == (stored[0]["digest_version"] or 2)
    if out["verified_version"] >= 2 and stored[0]["big_floor_n"] is not None:
        assert out["recomputation"]["orders"]["big_orders"] > 0
        assert out["recomputation"]["orders"]["reconciled"] is True
