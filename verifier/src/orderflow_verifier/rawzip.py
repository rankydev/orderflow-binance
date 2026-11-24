"""Lesen der Binance-Vision-ZIP-Rohdateien (nur lesend).

DuckDB liest ZIP nicht direkt (KONZEPT §2.6): ``zipfile`` öffnet das Archiv und reicht den
Mitglieds-Stream an den streamenden pyarrow-CSV-Leser weiter; DuckDB fragt den Arrow-Reader ab.
Die Datei wird nur im Lesemodus geöffnet, nichts wird entpackt oder geschrieben.
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pyarrow.csv as pacsv


def single_member(archive: zipfile.ZipFile) -> str:
    """Name der einzigen Datei im Archiv (Vision-ZIPs enthalten genau eine CSV)."""
    names = [i.filename for i in archive.infolist() if not i.is_dir()]
    if len(names) != 1:
        raise ValueError(f"erwartet genau eine Datei im Archiv, gefunden: {names}")
    return names[0]


@contextmanager
def open_zip_csv(
    zip_path: str | Path, member: str | None = None
) -> Iterator[pacsv.CSVStreamingReader]:
    """Streamender CSV-Leser über das (einzige) Mitglied eines ZIP.

    Hinweis: pyarrow leitet Spaltentypen aus den Daten ab. Für exakte Dezimalverarbeitung
    (Preis/Menge als Strings) setzen spätere Phasen ``ConvertOptions(column_types=...)``.
    """
    with zipfile.ZipFile(zip_path, "r") as archive:
        name = member or single_member(archive)
        with archive.open(name, "r") as fh:
            yield pacsv.open_csv(fh)
