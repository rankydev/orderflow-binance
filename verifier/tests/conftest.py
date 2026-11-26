import os

import pytest


def pytest_collection_modifyitems(config, items):
    skip_slow = pytest.mark.skip(
        reason="langsam: OF_VERIFIER_SLOW=1 setzen (liest data/ unter dem Repo)"
    )
    skip_db = pytest.mark.skip(
        reason="Datenbank: OF_VERIFIER_DB=1 und OF_DB_* setzen (Wegwerf-DB, vom Importer geschrieben)"
    )
    for item in items:
        if "slow" in item.keywords and os.environ.get("OF_VERIFIER_SLOW") != "1":
            item.add_marker(skip_slow)
        if "db" in item.keywords and os.environ.get("OF_VERIFIER_DB") != "1":
            item.add_marker(skip_db)
