# orderflow-binance

Orderflow-Charting für Binance USDT-M Futures (Footprint, Volume Profile, TPO, Big Trades), berechnet aus aggTrades.
Die verbindliche Spezifikation ist [`docs/KONZEPT.md`](docs/KONZEPT.md); dieses Repo ist nach Phase **P0 (Grundgerüst)** erst ein Gerüst ohne Anwendungslogik.

## Aufbau

| Pfad                 | Inhalt                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/core`      | reine Logik ohne I/O: Parser, Tagesaggregation, Rollups, Kline-Abgleich, Digests, Manifest-Typen         |
| `packages/db`        | Datenbankverbindung, Migrationsmechanismus, SQL-Migrationen (`migrations/`), CLI (`src/cli.ts`)          |
| `apps/importer`      | CLI: Download, Checksum, ZIP-Streaming, Import Tag/Bereich/Monat (Dry-Run oder DB), Manifest, Abgleich   |
| `apps/recorder`      | Daemon: WebSocket, Lücken, Spool (P2) – derzeit Platzhalter                                              |
| `apps/api`           | lesende HTTP/WS-API (P1) – derzeit Platzhalter                                                           |
| `apps/web`           | Svelte 5 + Vite + lightweight-charts: Kerzen + Footprint (P1), vorerst gegen Fixture-Kacheln             |
| `verifier/`          | Python + DuckDB, unabhängige Neuberechnung; eigenes venv (`verifier/.venv`), derzeit nur ZIP-Leser       |
| `docker-compose.yml` | lokale PostgreSQL-17 + TimescaleDB-Community-Datenbank                                                   |
| `data/`              | Rohdaten und Spool, **git-ignoriert, nie anfassen/einchecken** (Quelle der Wahrheit, siehe KONZEPT §3.1) |

Pakete sind npm-Workspaces. Interne Pakete exportieren ihren TypeScript-Quelltext direkt (`exports: ./src/index.ts`), Node führt `.ts` nativ aus (Type-Stripping): es gibt keinen Build-Schritt für Backend-Code; Imports tragen die Endung `.ts`.

## Voraussetzungen

- **Node 24 LTS** (`.nvmrc` = 24.22.3, `engines` `>=24.22.0 <25`): `nvm use`
- **Docker** (Docker Desktop, OrbStack o. Ä.) für die lokale Datenbank
- **Python >= 3.12** für den Verifier (lokal getestet mit 3.14)

## Einrichtung

```bash
nvm use                    # Node 24.22.3
npm ci                     # Abhängigkeiten (Lockfile)
cp .env.example .env       # Passwort anpassen; .env ist git-ignoriert
npm run py:setup           # verifier/.venv + gepinnte Pakete
```

## Datenbank

PostgreSQL 17 + TimescaleDB Community (Image `timescale/timescaledb:2.31.2-pg17`, gepinnt), nur auf `127.0.0.1:54320`, Daten im benannten Volume `orderflow-binance_pgdata`.

```bash
npm run db:up        # startet den Container und wartet auf "healthy"
npm run db:migrate   # wendet ausstehende Migrationen an (idempotent)
npm run db:status    # zeigt angewendet/ausstehend
npm run db:rollback  # rollt die letzte Migration zurück (db:rollback -- 3 | all)
npm run db:reset     # Datenbank löschen, neu anlegen, alles migrieren (nur lokal)
npm run db:psql      # psql in der Datenbank
npm run db:down      # Container stoppen (Daten bleiben)
npm run db:destroy   # Container + Volume löschen (alle lokalen Daten weg)
```

**Migrationen** liegen als SQL-Dateipaare in `packages/db/migrations/` (`NNNN_name.up.sql` / `NNNN_name.down.sql`, lückenlos ab `0001`). Der eigene kleine Runner (`packages/db/src/migrate.ts`) führt jede Migration in einer Transaktion aus, protokolliert sie samt SHA256 in `schema_migrations`, nimmt einen Advisory-Lock und lehnt nachträglich geänderte, bereits angewendete Migrationen ab (neue Änderung = neue Migration). `db:reset` verweigert Hosts außer `127.0.0.1`/`localhost`.

Stand nach P0 (nur die P1-Tabellen aus KONZEPT §3): `symbol`, `symbol_tick_history`, `raw_file`, `raw_day`, `data_day`, `data_minute_issue`, `verify_run`; Hypertables mit Columnstore-Policy `fp_1m`, `fp_1m_b10`, `fp_5m_b10`, `fp_15m_b100`, `fp_1h_b10`, `fp_1h_b100`, `fp_1d_b100`, `fp_1d_b1000`, `bar_1m`, `bar_1h`, `bar_1d`, `kline_1m` (Chunk-Intervalle und Fristen nach §3.9); SQL-Funktion `day_digest(tabelle, sym, tag)` (§4.8). Nicht enthalten: `size_hist_*`, `big_order` (P5), `ingest_status` und DB-Rollen (P2).

## Tests und Qualität

```bash
npm test             # Unit-Tests (Vitest), keine DB nötig
npm run test:db      # DB-Integrationstests (Schema, Postgres-Schreiber) gegen die lokale DB ("orderflow_test")
npm run test:golden  # opt-in: Golden-Tests auf echten Dateien unter data/ (nur lesend, ~2,5 min)
npm run typecheck    # tsc bzw. svelte-check in allen Paketen
npm run lint         # ESLint + Prettier-Check
npm run format       # Prettier schreibt
npm run build        # Web-Build (Vite)
npm run test:py      # Verifier-Tests (pytest)
npm run lint:py      # ruff check + format
npm run check        # lint + typecheck + test + build
```

CI (`.github/workflows/ci.yml`) führt dieselben Schritte aus und startet für `db` eine Timescale-Instanz.

## Verifier

```bash
verifier/.venv/bin/python -I -c "import duckdb, pyarrow"
```

DuckDB liest ZIP nicht direkt. `orderflow_verifier.rawzip.open_zip_csv(pfad)` öffnet das Archiv nur lesend mit `zipfile` und reicht den Mitglieds-Stream an den streamenden pyarrow-CSV-Leser; DuckDB fragt den Arrow-Reader ab (`con.register('agg', reader)`). Beispiel siehe `verifier/tests/test_rawzip.py`. Achtung: pyarrow inferiert Preis/Menge als `double` – für exakte Rechnung später `ConvertOptions(column_types=...)` mit Strings verwenden (KONZEPT §4.4).

## Web (P1, gegen Fixtures)

```bash
npm run fixtures -w @orderflow/web   # Kacheln aus data/raw (BTCUSDT 2026-11-20…22) → apps/web/fixtures/ (git-ignoriert, ~220 MB)
npm run dev -w @orderflow/web        # http://127.0.0.1:5173/  (FIXTURE_LATENCY_MS=25 simuliert Netzlatenz)
```

Produktion (statisches Bundle, spricht `/api/v1` am **eigenen Ursprung** an, z. B. nginx: `/` → `apps/web/dist`,
`/api/` → API auf 127.0.0.1:8780):

```bash
npm run build -w @orderflow/web                          # → apps/web/dist (≈ 308 kB JS, ≈ 105 kB gzip)
API_PROXY=http://127.0.0.1:8780 npx -w @orderflow/web vite preview   # Build lokal gegen die echte API prüfen
API_PROXY=http://127.0.0.1:8780 npm run dev -w @orderflow/web        # Entwicklung gegen die echte API statt Fixtures
```

`VITE_API_BASE=https://…` (beim Build) nur, wenn die API auf einem anderen Ursprung liegt (dann CORS an der API).
Die Seite übernimmt Symbole, Zeitrahmen und Datenstand („Daten bis …") aus `/api/v1/symbols` und lädt die Liste alle
5 min neu. URL-Zustand: `?sym=&tf=&type=&r=&at=<Unix-Sekunden>` (at = Ansicht um diese Zeit). Die Diagnosezeile ist in
Produktion eingeklappt („▸ Diagnose"), `&debug` öffnet sie und stellt `window.__of` bereit.

Content-Security-Policy für die Seite (nginx, `add_header … always;`), im Browser geprüft (Laden, Pannen, Zoomen,
Hover, tf-/Typwechsel, Diagnosezeile: keine Verletzung; der Hash gehört zum `<style>`-Element, das
lightweight-charts 5.3.0 für sein Logo einfügt – bei einem Update der Bibliothek neu bestimmen):

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY='; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
```

Anfragelast je Tab (gemessen gegen die Fixture-API, 90-Tage-Datensatz): Seitenstart ≈ 9–11 Anfragen in ≈ 1 s
(Symbole, Bar-Abschnitte, 2–3 Kacheln); 10 s schnelles Pannen 3–13 Anfragen, Spitze 2/s (auch herausgezoomt).
Höchstens 4 parallel (Client). `limit_req` 10 r/s mit Burst 40 je IP reicht mit großer Reserve.

Die Dev-Middleware (`apps/web/dev/fixture-api.ts`) bedient `/api/v1/symbols|bars|footprint|profile|profiles/daily` in der URL-Form der
künftigen API; mit `VITE_API_BASE=<url>` spricht das Frontend stattdessen die echte API an. Symbole: `BTCUSDT`
(echt), `BTCUSDT-SYN90` (90 Tage, 30× wiederholte echte Tage, nur Performance), `STRESS-FLAT` (Seitwärtsdaten
für den Zellbudget-Test). Kachelformat: [`docs/TILE-FORMAT.md`](docs/TILE-FORMAT.md). Offen für die Live-Phase: Bar-Abschnitte und `/symbols` werden im Browser nicht aktualisiert (siehe
TILE-FORMAT.md, „Offen für die Live-Phase"). Messung (T11) im Browser:
`PLAYWRIGHT_CORE=<pfad zu playwright-core> node apps/web/perf/measure.ts` bei laufendem Dev-Server.

**Volumenprofil + Delta** (Vertrag: [`docs/PROFILE-API.md`](docs/PROFILE-API.md)): standardmäßig je sichtbarem Tag
ein Profil ab dem Tagesbeginn nach rechts, unter Kerzen/Footprint gezeichnet (Pane-Primitive, kein DOM-Overlay).
Breite = min(80 % des Tages, max(120 px, 30 % der Pane)); ist der Tag breiter als die Pane und der Footprint zeigt
Zellen, höchstens 25 % der Pane. Liegt der Tagesbeginn links außerhalb, bleibt das Profil am linken Rand sichtbar
(auch das Bereichsprofil). Schmale Tage: unter 16 px ausgelassen (Anzeige sagt es), 16–48 px nur die Silhouette
(Total-Form + POC-Strich), ab 48 px alles. Skala je Profil (Standard) oder „gemeinsame Skala" über die sichtbaren
Tage; der Hover nennt die Länge des längsten Balkens. Ansichten „Total", „Buy/Sell" (Standard; Bid rot links, Ask grün rechts gestapelt) und „Delta"
(|Ask − Bid| ab dem Tagesbeginn, grün/rot nach Vorzeichen) – ein Klick in der Werkzeugleiste. Gelbe Linie = POC,
VA-Fläche + graue VAH/VAL („VA"), „verlängern" = POC/VAH/VAL bis zur ersten Berührung durch den Preis (naked).
„Bereich wählen": zwei Klicks im Chart (Bar-genau, auf Minuten gerundet, Esc bricht ab) → Bereichsprofil mit
Zusammenfassung unter dem Chart (Zeitraum, gesamt/Ask/Bid/Delta in Lots und BTC, POC, VA). Profil-Zeilengröße
automatisch nach Pixelhöhe (≈ 5 px, unabhängig vom Footprint-R) oder fest („Profilzeile"); lehnt der Server mit 422
ab, wird einmal mit `suggestR` neu angefragt (Hinweis in der Anzeige). Tagesprofile werden in Blöcken à 16 Tage geladen (`/profiles/daily`), nur sichtbar ± 1 Tag, mit
Abbruch und LRU, höchstens 2 parallel und erst, wenn keine Kacheln/Bars laden; von einem nicht finalen Block wird
nur der offene Rest neu geladen. Finale Tage werden gegen die geladenen Bars geprüft (Abweichung → einmal am
Browser-Cache vorbei neu laden, dann eine Meldung, die bis zum Schließen stehen bleibt).
URL: `pm=off|daily|range|both`, `pv=total|buysell|delta`, `va=<1…100>`, `oh=<−11…12>` (Tagesbeginn UTC + h),
`ps=common` (gemeinsame Skala),
`pr=<Ticks>` (fest), `pe=1` (verlängern), `pl=0` (ohne VA), `pf=`/`pt=` (Bereich, ISO-Minute UTC, z. B.
`2026-10-27T00:00`); nur vom Standard Abweichendes steht in der URL (Standard: `PROFILE_DEFAULTS` in
`apps/web/src/lib/profile/model.ts`). Messung nur der Profil-Szenarien, auch gegen die echte API:
`PERF_ONLY=profile PERF_PROFILE_SYM=BTCUSDT PERF_URL=… node apps/web/perf/measure.ts`.

## Importer (P1)

```bash
npm run import -- import --symbol BTCUSDT --day 2026-11-20                  # Dry-Run (Standard), schreibt nichts
npm run import -- import --symbol BTCUSDT --from 2026-11-20 --to 2026-11-22 --out /tmp/r.jsonl
npm run import -- import --symbol BTCUSDT --month 2026-10 --prefer monthly   # Monatsdatei nach UTC-Tag zerlegt
npm run import -- import --symbol BTCUSDT --month 2026-10 --db --resume      # in die DB (OF_DB_*), fertige Tage überspringen
npm run import -- download --symbol BTCUSDT --kind klines --from 2026-10-01 --to 2026-10-31
```

Je Tag: SHA256 gegen `.CHECKSUM`, streamendes ZIP-Lesen (eigener Leser, CRC32-Prüfung), exakter Ganzzahl-Parser,
fp_1m + alle Rollups aus KONZEPT §3.6, bar_1m/1h/1d, Kline-Abgleich §4.6 mit Übertrag über Tages- und Monatsgrenzen
(Nachbartage an den Bereichsrändern werden nur gelesen), Daten-Digest je Tabelle (= SQL `day_digest`, ohne
`check_state`) und Tages-Digest (= `day_digest_all`). Tag d wird erst geschrieben, wenn d+1 abgeglichen ist.
`--prefer auto|daily|monthly` wählt die aggTrades-Quelle; `--no-neighbours` liest keine Nachbartage (Randminuten
bleiben `edge_pending`); `--sidecar`/`--sidecar-dir` schreibt das Manifest-Sidecar. Exit-Code 3 bei `final_bad`.

## Deployment (VPS)

Produktion unter `https://orderflow.rankyhub.com` (öffentlich, ohne Login): Dateien und Skripte in
[`deploy/`](deploy/), Entscheidungen und Server-Bestandsaufnahme in
[`deploy/README.md`](deploy/README.md), Ablauf mit Prüfungen und Rücknahme je Schritt in
[`deploy/RUNBOOK.md`](deploy/RUNBOOK.md). Kurz: DB und API als Docker-Compose-Projekt
`orderflow-binance` (nur `127.0.0.1`), Historie per `pg_dump`/`pg_restore` vom Mac übertragen und
gegen einen Prüfbericht verglichen (`deploy/transfer-db.sh`), Releases auf dem Mac gebaut
(`deploy/build-release.sh`, `deploy/release.sh`), eigene nginx-Site (`deploy/nginx-setup.sh`).
Ziel-Host nur in `deploy/.env.deploy` (git-ignoriert), Secrets nur auf dem Server.

## Konfiguration

Nur über Umgebungsvariablen (`.env`, nie im Repo; Vorlage `.env.example`): `OF_DB_HOST`, `OF_DB_PORT` (Standard 54320), `OF_DB_USER`, `OF_DB_PASSWORD` (Pflicht), `OF_DB_NAME`, `OF_DATA_DIR`, `OF_LOG_LEVEL`. Das Parsen und Validieren liegt rein in `packages/core/src/config.ts`; die Einstiegspunkte laden `.env` per `node --env-file-if-exists=.env`.

## Entscheidungen in P0 (wo das Konzept offen ließ)

- Node 24.22.3 per nvm (Konzept: Node 24 LTS); Python-Pins gelten für 3.12 bis 3.14.
- npm-Workspaces statt pnpm (pnpm nicht installiert); exakte Versionen (`save-exact`), TypeScript 6.0 (typescript-eslint unterstützt TS 7 noch nicht).
- Interne Pakete ohne Build: `.ts`-Quelltext als Export, Node-Type-Stripping, `erasableSyntaxOnly`.
- Zusätzliches Paket `packages/db` (Konzept nennt es nicht), damit `packages/core` frei von I/O bleibt.
- Eigener SQL-Migrationsrunner (up/down) statt Fremdwerkzeug; Reset = Datenbank droppen + neu anlegen (nicht `DROP SCHEMA`, weil die Timescale-Erweiterung im Schema `public` liegt).
- Hypertables ohne Standardindex auf `ts` (`create_default_indexes => false`); der Primärschlüssel deckt die Abfragen ab. Keine Fremdschlüssel von Hypertables auf `symbol` (Kosten je Zeile beim Massen-`COPY`).
- Jahres-Chunks als `365 days` (Timescale rechnet Monats-/Jahresintervalle in feste Tage um).
- `bar_1h`/`bar_1d`: Spalten wie `bar_1m` ohne `source`/`check_state`; `run_max`/`run_min`/`d_from_*` tragen dort die Kompositwerte.
- `raw_file` (PK = relativer Pfad) und `raw_day` (PK `sym_id, kind, day`) aus den Manifestfeldern von §3.1 abgeleitet; `CHECK`-Constraints für Zustände/Arten.
- `day_digest` nutzt die Postgres-Zeilentextform (Zeitzone/Datumsstil an die Funktion gebunden).
- Lokaler DB-Port 54320; Datenbanken `orderflow` (Entwicklung) und `orderflow_test` (Tests).
