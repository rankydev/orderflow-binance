import zipfile

import duckdb
import pytest

from orderflow_verifier.rawzip import open_zip_csv, single_member

CSV = (
    "agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n"
    "1,100.50,0.010,1,1,1700000000000,true\n"
    "2,100.60,0.020,2,3,1700000000001,false\n"
)


@pytest.fixture
def zip_path(tmp_path):
    p = tmp_path / "BTCUSDT-aggTrades-2026-01-01.zip"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("BTCUSDT-aggTrades-2026-01-01.csv", CSV)
    return p


def test_duckdb_queries_zip_via_arrow(zip_path):
    with open_zip_csv(zip_path) as reader:
        con = duckdb.connect(":memory:")
        con.register("agg", reader)
        n, last = con.execute("select count(*), max(agg_trade_id) from agg").fetchone()
    assert (n, last) == (2, 2)


def test_rejects_archives_with_several_members(tmp_path):
    p = tmp_path / "x.zip"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("a.csv", "a\n1\n")
        z.writestr("b.csv", "a\n1\n")
    with zipfile.ZipFile(p) as z, pytest.raises(ValueError):
        single_member(z)
