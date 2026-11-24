import os

import pytest


def pytest_collection_modifyitems(config, items):
    if os.environ.get("OF_VERIFIER_SLOW") == "1":
        return
    skip = pytest.mark.skip(
        reason="langsam: OF_VERIFIER_SLOW=1 setzen (liest data/ unter dem Repo)"
    )
    for item in items:
        if "slow" in item.keywords:
            item.add_marker(skip)
