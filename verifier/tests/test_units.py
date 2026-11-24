import duckdb
import pytest

from orderflow_verifier.units import dec_int_sql, lots_to_str


def conv(s: str, dec: int):
    con = duckdb.connect()
    con.execute("CREATE TABLE t AS SELECT ? AS s", [s])
    return con.execute(f"SELECT {dec_int_sql('s', dec)} FROM t").fetchone()[0]


@pytest.mark.parametrize(
    ("text", "dec", "expected"),
    [
        ("100.50", 2, 10050),
        ("100.5", 2, 10050),  # kürzerer Nachkommateil wird aufgefüllt
        ("58915.0", 2, 5891500),
        ("58915", 2, 5891500),
        ("0.005", 3, 5),
        ("0.0", 3, 0),
        ("1.2300", 2, 123),  # überzählige Nullen sind zulässig
        ("1622.020", 3, 1622020),
        ("12345678.90123", 5, 1234567890123),  # Notional ohne Gleitkomma
        ("9007199254740993.001", 3, 9007199254740993001),  # > 2**53: Float würde hier runden
    ],
)
def test_exact_decimal_parsing(text, dec, expected):
    assert conv(text, dec) == expected


@pytest.mark.parametrize(
    "bad", ["1.234", "1e5", "-1.00", "", ".5", "1.", "1,5", " 1.0", "abc", "1.2.3"]
)
def test_rejects_off_grid_and_malformed(bad):
    with pytest.raises(duckdb.Error):
        conv(bad, 2)


def test_lots_to_str():
    assert lots_to_str(13, 3) == "0.013"
    assert lots_to_str(-13, 3) == "-0.013"
    assert lots_to_str(1234567, 3) == "1234.567"
