"""Verifier: unabhängige Neuberechnung (Python + DuckDB) nach KONZEPT §4.7 und §4.8.

Entsteht ausschließlich aus docs/KONZEPT.md, den SQL-Migrationen (Tabellen, day_digest) und den
Rohdateien; der TypeScript-Importer wurde nie gelesen.

Aufruf (vom Repo-Wurzelverzeichnis)::

    npm run verify -- day  --sym BTCUSDT --day 2026-11-21 [--deep] [--json out.json]
    npm run verify -- deep --sym BTCUSDT --day 2026-11-21
    npm run verify -- db   --sym BTCUSDT --day 2026-11-21     # UNGETESTET, braucht psycopg + DB
    npm run verify -- compare importer.jsonl out1.json out2.json ...
"""

__version__ = "0.1.0"
