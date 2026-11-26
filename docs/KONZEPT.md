# orderflow-binance – Konzept

Stand: 2026-11-24 · Fassung 3 · Status: **in Umsetzung** (P0 erledigt, P1 in Arbeit, §8)

Dieses Dokument ist die verbindliche Grundlage für Implementierung und Review. Änderungen am Konzept werden hier nachgezogen, bevor Code entsteht, der davon abweicht. Kennzeichnung: **[v1]** = erste Ausbaustufe, **[später]** = geplant, nicht v1, **[nice]** = nur wenn billig. „(unbestätigt)" markiert Angaben über Fremdprodukte, die nicht aus offizieller Doku belegt werden konnten. Bei Zahlen steht, ob sie **gemessen**, **an Stichproben bewiesen**, **geschätzt/abgeleitet** oder **offen** sind. Fassung 2 arbeitete das Review (`KONZEPT-REVIEW.md`), ein Datenexperiment und Nutzerentscheidungen ein (§11); Fassung 3 übernimmt den gebauten Stand und die Messungen aus Implementierung und Gesamt-Historien-Scan (§12).

Ergänzende, verbindliche Dokumente: [`TILE-FORMAT.md`](TILE-FORMAT.md) (API-Vertrag für `symbols`/`bars`/`footprint`, Kachelformat, Kachellänge), `PROFILE-API.md` (Vertrag des Volume-Profile-Endpunkts, entsteht gerade), [`../README.md`](../README.md) (Bedienung, Werkzeuge). Bei Widerspruch gelten diese Dokumente für ihren Gegenstand; das Konzept beschreibt Regeln und Entscheidungen, nicht den Code.

---

## 1. Ziele, Nicht-Ziele, Prioritäten

### 1.1 Ziel

Eine eigene Orderflow-Charting-App für Binance USDT-M Futures (zunächst BTCUSDT, ETHUSDT) mit Footprint (inkl. Delta-Ansicht), Volume Profile, TPO und Big Trades – berechnet **aus aggTrades**, nachweisbar korrekt und auch über Monate flüssig bedienbar.

### 1.2 Prioritäten (bei Zielkonflikten bindend)

1. **Performance**, besonders bei großen Zeiträumen.
2. **Beweisbare Datenkorrektheit.**
3. **Konzept statt Wildwuchs:** jede Komponente hat einen Zweck, eine Eigentümerschaft an Daten und Tests.

### 1.3 Nicht-Ziele (jetzt)

News-Marker/Crawler, Telegram-Alerts als Feature, CVD-Pane und „Control Score", Auto-Trader/Strategien/Signale, Account-/Order-Funktionen, andere Börsen, Kompatibilität mit PulseBot, Migration der PulseBot-Mongo-Daten.

### 1.4 Performance-Budgets

Zielwerte; „warm" = Daten im Page-Cache/shared_buffers, „kalt" = erster Zugriff nach Neustart von Postgres. Bestätigung per Benchmark auf dem VPS ist Abnahmekriterium von P1 (Fälle in §8).

| Metrik | warm | kalt |
|---|---|---|
| Erstes Rendern (1m-Footprint, ~200 Bars sichtbar) bis interaktiv | ≤ 1,0 s | ≤ 2,0 s |
| API p95 `bars` (beliebiger sichtbarer Bereich) | ≤ 100 ms | ≤ 300 ms |
| API p95 `footprint`-Kachel | ≤ 250 ms | ≤ 800 ms |
| API p95 Range-Profil (bis 1 Jahr, Auto-R) | ≤ 300 ms | ≤ 1 s |

| Weitere Grenze | Wert |
|---|---|
| Antwortgröße | ≤ 30 000 Zellen je Kachel (Kachellänge passt sich an, §5.3), hart ≤ 60 000 |
| Gelesene Quellzeilen je Request | ≤ 1,5 Mio. (Schätzung vor Ausführung, sonst Ablehnung mit Vorschlag für gröberes R) |
| Sichtbare Zellen im Chart | ≤ 25 000 (LOD-Regel §7.2) |
| Pan/Zoom | Zeichnen ≤ 8 ms/Frame (≤ 16 ms inkl. Bibliothek); kein Main-Thread-Task > 50 ms; Pan/Zoom wartet nie aufs Netz |
| Live: Trade → sichtbare Aktualisierung | ≤ 300 ms, max. 4 Redraws/s |
| Speicher Browser-Tab | ≤ 400 MB |
| Recorder-Verzögerung | Warnung > 30 s, Alarm > 120 s |

Bisherige Messungen gegen diese Budgets (Mac, warm, echte BTC-Daten bzw. Fixtures; VPS-Messung steht aus, M1): §5.8 (API) und §7.2 (Rendering). Sie liegen deutlich innerhalb der Budgets; das ist **kein** Nachweis für den VPS und für kalte Zugriffe.

### 1.5 Korrektheitsgarantien

| # | Garantie | Wie erzwungen |
|---|---|---|
| K1 | Jeder Tag mit Status `final_*` stammt aus der offiziellen Binance-Tagesdatei mit geprüfter SHA256 | Manifest; Ersatz erst nach Checksum + vollständigem Parse (§4.3) |
| K2 | Preise werden ohne Gleitkommafehler auf Ganzzahlen abgebildet | Integer-Parser (§4.4) |
| K3 | Mengen und Notional werden exakt summiert | Ganzzahlige Lots und ganzzahliges Notional (§3.2) |
| K4 | Pro Minute stimmen Volumen und Taker-Buy-Volumen mit der Binance-1m-Kline überein oder die Abweichung liegt nachweislich in der engen Minutengrenzen-Hülle (`shift`); Tagessummen exakt bis auf Tagesrand-Straddler. Jede andere Abweichung wird als `mismatch`/`missing` sichtbar – auch wenn die Ursache bei Binance liegt (Quellfehler werden annotiert, nicht weggerechnet) | Abgleich nach jedem Import (§4.6) |
| K5 | Auf Stichprobentagen ist bewiesen, dass die Klines exakt aus den Einzelfills folgen und unsere Minuten exakt der Produktregel entsprechen | Tiefenprüfung gegen den trades-Dump (§4.7) |
| K6 | Keine unbemerkten Lücken | Live: aggId-Kontinuität. Historie: **der Kline-Abgleich** – die aggId-Kontinuität der Dumps erkennt Löcher nachweislich nicht (§4.5). Dazu Tagesstatus, Health + Totmann (§2.5, §4.2) |
| K7 | Eine Minute wird vollständig oder gar nicht geschrieben; nie partiell, nie von zwei Schreibern | Zustandsautomat + Single Writer + Replace (§4.3) |
| K8 | Aggregate sind reproduzierbar | Re-Import erzeugt identische Tages-Digests; Mac und VPS vergleichen Digests (§2.3, §4.8) |
| K9 | Unabhängige Zweitberechnung stimmt überein | Python/DuckDB-Verifier inkl. aller Rollups und API-Stichprobe (§4.8) |
| K10 | Die UI zeigt jederzeit, wie verlässlich die angezeigten Daten sind | Qualitätsband + Statusendpunkt (§4.9) |
| K11 | Daten aus dem Zeitraum mit nachweislich unvollständigen aggTrades-Dumps (bis 2026-06-09) erscheinen nie als geprüft, solange sie nicht repariert sind | Regime-Schnitt (§3.1), v1-Historie ab 2026-06-10, Reparaturphase P7 (§4.11) |

---

## 2. Architektur

### 2.1 Prozesse

| Prozess | Aufgabe | Läuft | Schreibt |
|---|---|---|---|
| `recorder` | WebSocket aggTrade je Symbol, Lückenerkennung + REST-Nachholen, Spool-Dateien, fertige Minuten als provisorisch in die DB, lokaler Trade-Feed für die API | VPS, Daemon (`Type=notify`) | Basistabellen nur für Tage im Zustand `provisional`; `ingest_status` |
| `importer` | Download Tagesdateien (aggTrades + Klines; Erstimport zusätzlich Monatsdateien, §3.1), Checksum, Manifest, Tagesaggregation, atomarer Tages-Ersatz, Abgleich mit Kaskade auf den Folgetag; Modi Dry-Run / DB, `--backfill` / `--online`, `--plan` (§4.1) — **gebaut** | Mac: Historie/Neuberechnung; VPS: tägliche Finalisierung (Timer) | Aggregate für Tage im Zustand `importing`; `raw_file`, `data_day`, `data_minute_issue`, `kline_1m` |
| `api` | HTTP (Binärdaten), WebSocket (formender Bar), Health-Endpunkt, Big-Trade-Schwellen | VPS, Daemon | nichts (DB-Rolle nur lesend) |
| `web` | statisches Frontend (Svelte 5 + lightweight-charts) | nginx (VPS), Vite (Mac) | – |
| `verifier` | unabhängige Neuberechnung (Python + DuckDB) im Datei- und im DB-Modus (**gebaut**), Tiefenprüfung gegen trades-Dump | Mac; auf dem VPS nur in ruhigen Zeiten (2–4,7 GB RSS je Tag, gemessen; nie parallel zu schweren Abfragen) | nur `verify_run` |
| `health-ping` | systemd-Timer alle 5 min: ruft Health ab, pingt Totmann-Dienst nur bei `healthy` | VPS | – |

Begründung: Live-Ingestion, Import und Chart-API teilen sich keinen Event-Loop (PulseBot-Lektion); jeder Datenbereich hat genau einen Schreiber. Faktisch sind es zwei Daemons und drei Timer/CLIs.

### 2.2 Datenfluss

```
Binance WS ──► recorder ──► data/live/… (Spool, zstd-Frames, Vision-CSV-Format)
                 │  ├──► Postgres (provisorische Minuten, ingest_status)
                 │  └──► localhost-Feed (Trades + „Minute M committed") ──► api ──► Browser-WS
Binance REST ◄──┘ (Lücken per fromId)

data.binance.vision ──► importer ──► data/raw/… + Manifest ──► Postgres (final, atomarer Tages-Ersatz)
   (aggTrades, klines 1m;                └──► Abgleich ──► data_day / data_minute_issue
    trades nur Stichprobe) ──► verifier (DuckDB) ──► verify_run
Postgres ──► api (nur lesend) ──► Browser
```

### 2.3 Was läuft wo – Mac und VPS

Entscheidung: **Das Rohdatenarchiv liegt auf dem Mac**, die Historie wird auf dem Mac berechnet und als fertige Tabellen auf den VPS übertragen. Der VPS hält nur ein rollierendes Fenster der Tagesdateien.

| | Mac | VPS |
|---|---|---|
| Rohdaten | vollständiges Archiv ab 2025-01-01: aggTrades 29,2 GB als ZIP (BTC 12,9 GB, ETH 16,4 GB, gemessen für 2025-01-01…2026-11-23), Klines 87 MB; trades-Dumps für Stichprobentage, für die Reparaturphase P7 zusätzlich ≈ 525 Tage/Symbol (geschätzt 30–50 GB) | letzte 14 Tage aggTrades + Klines (≈ 1 GB, abgeleitet) |
| Postgres + Timescale | OrbStack (Docker-kompatibel; Docker Desktop vom Nutzer abgelehnt), Image gepinnt `timescale/timescaledb:2.31.2-pg17`, nur `127.0.0.1:54320`; vollständige DB | Docker, gleiche Version; vollständige DB (aus Transfer + tägliche Finalisierung) |
| Prozesse | importer (Backfill, Neuberechnung, täglicher Nachzug wenn eingeschaltet), verifier, Entwicklung | recorder, api, importer (täglich), health-ping, nginx |

Backup: Archiv auf dem Mac zusätzlich auf eine externe Platte oder einen Cloud-Speicher spiegeln; monatlicher SHA256-Abgleich gegen das Manifest (Skript). Jede Datei ist zudem bei Binance erneut ladbar, solange Binance sie anbietet.

**Was der VPS ohne den Mac kann:** Charts ausliefern; live aufzeichnen; jeden Tag selbst finalisieren (lädt die Tagesdatei und die Klines selbst, ersetzt, gleicht ab); den leichten Verifier über das 14-Tage-Fenster laufen lassen; alarmieren.

**Was den Mac (oder einen Neu-Download von Binance) braucht:** Neuberechnung der Historie nach einer Regeländerung (z. B. Order-Merge-Regel, Big-Trade-Untergrenze, neue Rollup-Stufe, neue Tabelle); Historie eines neuen Symbols; Tiefenprüfung alter Tage; Wiederaufbau nach DB-Verlust (Mac überträgt erneut).

**Täglicher Gleichlauf:** Ist der Mac eingeschaltet, lädt er dieselben Tagesdateien (für das Archiv) und importiert sie mit derselben Importer-Version. Beide Seiten berechnen je (Symbol, Tag) einen Digest (§4.8); der Mac holt die VPS-Digests per SSH und meldet Unterschiede. Das ist eine zusätzliche Reproduzierbarkeitsprüfung (K8).

**Transferverfahren (Erstübertragung):**
1. Mac: Backfill im Backfill-Modus (§4.1), alle Chunks außerhalb der letzten 3 Tage sind danach komprimiert.
2. Mac: `pg_dump -Fd -j 4` (Verzeichnisformat, parallel) der Anwendungsdatenbank. Komprimierte Chunks liegen in Timescales internen komprimierten Tabellen und werden in dieser Form gesichert, d. h. der Dump enthält die Basistabelle nicht entpackt (an einer Test-DB vor dem ersten echten Transfer bestätigen – **offen**). Erwartete Größe ≈ DB-Größe; für v1 (BTC ab 2026-06-10, ≈ 167 Tage) hochgerechnet ≈ 0,8–1,2 GB (abgeleitet aus §3.10).
3. `rsync` auf den VPS, SHA256 je Dump-Datei vergleichen.
4. VPS: leere DB mit **identischer** Postgres- und Timescale-Version, `SELECT timescaledb_pre_restore();` → `pg_restore -j 2` → `SELECT timescaledb_post_restore();`. Spitzenbedarf Platte ≈ Dump + DB ≈ 20 GB (von 80 GB frei); Dump danach löschen.
5. Prüfung: Digest je (Tabelle, Symbol, Tag) auf beiden Seiten identisch; `data_day` identisch. Erst dann wird der VPS-Recorder für die Tage nach dem Transferstand freigeschaltet.

**Transferverfahren (Teilübertragung nach Neuberechnung):** Der Mac exportiert nur die betroffenen Tabellen und Tage als `COPY … TO STDOUT (FORMAT binary)` je (Tabelle, Symbol, Tag) mit Digest. Der VPS spielt sie chunkweise ein, mit demselben Weg wie der Importer (§4.3): `convert_to_rowstore` → Tage per Delete + COPY ersetzen → `convert_to_columnstore` → nächster Chunk. Es ist also höchstens ein Chunk zur Zeit unkomprimiert (bei `fp_1m` ≈ 1 Tag ≈ 65 MB); **die VPS-Platte hält nie die unkomprimierte Basistabelle.** Danach Digest-Vergleich wie oben.

### 2.4 Deployment auf dem geteilten VPS (2 vCPU, 7,8 GB RAM, ~5,9 GB frei, 80 GB Platte frei)

| Komponente | Betrieb | Limits / Einstellungen |
|---|---|---|
| Postgres 17 + TimescaleDB Community | Docker-Image exakt gepinnt (`timescale/timescaledb:2.<x>.<y>-pg17`, Version bei Installation festlegen); **kein** Port nach außen: entweder `127.0.0.1:5432:5432` oder Unix-Socket über ein gemountetes Verzeichnis (Docker-Portfreigaben umgehen UFW) | `mem_limit 2.5g`, `cpus 1.5`; `shared_buffers=640MB`, `effective_cache_size=1.5GB` (Page-Cache zählt gegen das Container-Limit), `work_mem=32MB`, `maintenance_work_mem=256MB`, `max_connections=30`, `timescaledb.max_background_workers=4` |
| recorder | systemd `Type=notify`, `WatchdogSec=60`, `Restart=always` | `MemoryMax=300M`, `CPUQuota=30%` |
| api | systemd, `Restart=always` | `MemoryMax=600M`, `CPUQuota=100%` |
| importer | systemd-Timer 07:45 UTC, Wiederholung alle 30 min bis Erfolg | `Nice=10`, `IOSchedulingClass=idle`, `MemoryMax=1.2G`, `CPUQuota=100%` |
| health-ping | systemd-Timer alle 5 min | – |
| nginx | vorhandener Server, neuer vhost: HTTPS, öffentlich ohne Passwort (§10.2), gzip (Brotli ist im Ubuntu-22.04-Standardpaket voraussichtlich nicht enthalten; die API liefert finale Kacheln zusätzlich vorkomprimiert aus dem Cache), `limit_req` je IP auf `/api` (z. B. 10 r/s, Burst 40) und `limit_conn` je IP auf den WS | – |

DB-Rollen: `of_recorder` (INSERT/DELETE nur auf Basistabellen + `ingest_status`, Prüfung des Tageszustands per Trigger/Funktion), `of_importer` (alle Aggregattabellen, Qualitätstabellen), `of_api` (nur SELECT), `of_admin` (Migrationen). Secrets (DB-Passwörter, Totmann-URL) in `EnvironmentFile` mit Rechten 0600 bzw. systemd-Credentials, nie im Repo.

Summe der Limits ≈ 4,6 GB < 5,9 GB frei. PulseBot (pm2) und dessen mongod werden gestoppt, sobald der neue Recorder läuft (entschieden). Bis dahin teilen sich beide das REST-Gewicht der IP (2 400/min); der Recorder nutzt im Parallelbetrieb ≤ 25 %.

### 2.5 Monitoring und Alarm

Ziel: ein still gestorbener Stream (PulseBot: 36 Tage unbemerkt) oder ein toter VPS wird binnen Minuten per **E-Mail an den Nutzer** gemeldet, ohne SMTP-Zugangsdaten auf dem VPS.

| Ebene | Mechanismus |
|---|---|
| Recorder intern | kein WS-Message für 15 s → Reconnect; geplanter Wechsel nach 23 h mit Überlappung |
| systemd-Watchdog | Recorder sendet `WATCHDOG=1` nur, wenn der letzte Trade < 30 s alt ist; bleibt das 60 s aus, startet systemd den Recorder neu. DB-Ausfall löst keinen Neustart aus (Recorder spoolt weiter und schreibt nach) |
| `ingest_status` | Recorder schreibt alle 10 s: letzter aggId, letzter Trade-Zeitstempel, WS-Zustand, offene Lücken, ungeschriebene Minuten |
| Health-Endpunkt `GET /api/v1/health` | `healthy` nur wenn alles gilt: Recorder-Daten < 120 s alt je Symbol; DB erreichbar; letzter Importer-Lauf erfolgreich und kein Tag älter als 30 h nach Tagesende ohne `final_*`; freier Plattenplatz ≥ 10 GB; Uhr per chrony/timesyncd synchronisiert (Offset < 1 s); keine fehlgeschlagene systemd-Unit des Projekts. Sonst `unhealthy` mit Liste der Gründe |
| health-ping | ruft Health ab; `healthy` → Ping an den Totmann-Dienst; `unhealthy` → Fail-Ping mit den Gründen als Text (sofortiger Alarm) |
| Totmann-Dienst | **healthchecks.io**, Check mit Periode 10 min + Gnadenfrist 5 min, Benachrichtigung per E-Mail an den Nutzer. Bleibt der Ping aus (VPS tot, Timer tot, nginx/API tot) oder kommt ein Fail-Ping, mailt der Dienst |
| UI | roter Banner, wenn Live-Daten > 60 s alt oder sichtbare Tage nicht `final_ok` |

healthchecks.io: der kostenlose „Hobbyist"-Tarif ($0, 20 Checks) besteht laut Preisseite (geprüft 2026-11-24); E-Mail ist eine dokumentierte Benachrichtigungsart, dass sie im Gratis-Tarif enthalten ist, war nur aus Drittquellen belegbar – bei der Anmeldung bestätigen. Ein Check genügt; ein zweiter für den Mac-Abgleich ist optional. **Fallback:** ntfy (ntfy.sh oder selbst gehostet) als Benachrichtigungskanal; healthchecks.io kann ntfy auch selbst ansteuern. Ein reiner ntfy-Push vom VPS deckt den Totalausfall des VPS nicht ab, daher bleibt der externe Totmann das Primärsignal.

### 2.6 Tech-Stack (Empfehlung)

| Bereich | Wahl | Grund |
|---|---|---|
| Sprache Backend + Frontend | **TypeScript** (Node.js 24 LTS; gebaut mit 24.22.3 per nvm, ohne Build-Schritt per Type-Stripping) | ein Typsystem für API-Encoding und Frontend-Decoding; lightweight-charts ist JS; PulseBot-Module (Parser, Seitenzuordnung, Value Area) sind übertragbar |
| DB-Treiber | `postgres` (porsager) oder `pg` + `pg-copy-streams` | `COPY` für Massenimport |
| HTTP/WS | Fastify + `ws` | schnell, Schema-Validierung |
| Frontend | Svelte 5 + Vite, lightweight-charts 5.x (gepinnt) | Svelte bekannt; Chartdaten außerhalb der Reaktivität (§7.3) |
| Tests | Vitest + fast-check, Playwright | |
| Verifier | **Python + DuckDB + pyarrow** (lokal 3.14 im venv, CI 3.12) | andere Sprache und Engine. DuckDB liest ZIP nicht direkt: `zipfile` → pyarrow-CSV → DuckDB |
| DB | PostgreSQL 17 + TimescaleDB Community, columnstore-API (`enable_columnstore`, `add_columnstore_policy`; die alte Kompressions-API ist deprecated) | Entscheidung gesetzt |

Erwogen und verworfen: **Python/FastAPI als Backend** (zwei Sprachen zwischen Binärformat und Frontend; Aggregation liegt ohnehin in SQL/Importer); **Rust/Go** für Importer/Recorder (neue Sprache, Durchsatzbedarf ≈ 2 Mio. aggTrades/Tag/Symbol ist für Node unkritisch); **React/Solid** (kein Vorteil für Canvas-Rendering); **Continuous Aggregates** (§3.5); **ClickHouse/QuestDB** (Postgres/Timescale ist gesetzt, zusätzlicher Betrieb).

---

## 3. Datenmodell

### 3.1 Rohdateien (Quelle der Wahrheit)

**Quelle der Wahrheit sind die aggTrades-Dateien von Binance Vision** (gleiche Form wie der Live-Stream). Sie sind **nicht** unbedingt vollständig (§4.5): bis 2026-06-09 fehlen ihnen nachweislich „Tail-Fills", und am 2026-10-27 haben sie ein echtes Loch. Daraus folgen zwei Regime mit festem Schnitt:

| Regime | Zeitraum | Befund (§4.5) | Behandlung |
|---|---|---|---|
| **A – Tail-Verlust** | 2025-01-01 … 2026-06-09 | an 352 von 692 Tagen je Symbol ≥ 1 `mismatch`-Minute durch fehlende Tail-Fills (bewiesen an Fill-Daten, Gesamtscan) | **nicht in der v1-Historie**; Import erst in der Reparaturphase P7 mit Regel R-A (§4.11) |
| **B – vollständig bis auf Einzelfälle** | ab 2026-06-10 | 0 Tail-Fälle in 5,5 Monaten (Gesamtscan); ein echtes Loch 2026-10-27 00:02–00:30 UTC | **v1-Historie** (Nutzerentscheidung: zuerst der saubere Zeitraum); das Loch bleibt bis P7 als `final_bad` mit Annotation sichtbar |

Der Schnitt liegt bei 2026-06-10 00:00 UTC (letzter beobachteter Tail-Fall BTC 2026-06-09 02:35:29.755, ETH 02:04:57.889 UTC; der Tag 2026-06-09 gehört zu Regime A). Eine Ankündigung von Binance zu dieser Änderung ist nicht bekannt; der Zeitpunkt ist gemessen, die Ursache offen.

- **Erstimport der Historie:** Für abgeschlossene Monate werden die bereits geladenen und gegen ihre `.CHECKSUM` geprüften **Monatsdateien** verwendet. Tages- und Monatsdateien sind auch bezüglich der fehlenden Tails identisch (gemessen). Sie gleichwertig zu nutzen spart einen erneuten Download von ≈ 1 300 Tagesdateien mit denselben Daten. Der Importer zerlegt eine Monatsdatei beim Streamen nach UTC-Tag (`floor(T / 86 400 000)`). Ab da wird jeder Tag **genau wie eine Tagesdatei** behandelt: gleiche Manifest-Einträge je Tag, gleiche Digests, gleiche Klassifikation, gleiche Tagesrand-Behandlung, auch über Monatsgrenzen (Übertrag s(−1) und `continues_prev` vom letzten Tag des Vormonats).
- **Laufender Betrieb, VPS-Fenster, Monate ohne Monatsdatei:** ausschließlich Tagesdateien.
- Es gibt keine Überlappungsprüfung zwischen Monats- und Tagesdateien im Betrieb. Jeder Tag hat genau eine Quelle, die in seinem Manifest steht. Die Gleichwertigkeit wird einmalig in P1 nachgewiesen (§8).

```
data/raw/binance-vision/futures/um/monthly/aggTrades/{SYM}/{SYM}-aggTrades-{YYYY-MM}.zip(.CHECKSUM|.manifest.json)   # nur Erstimport
data/raw/binance-vision/futures/um/daily/aggTrades/{SYM}/{SYM}-aggTrades-{YYYY-MM-DD}.zip(.CHECKSUM|.manifest.json)
data/raw/binance-vision/futures/um/daily/klines/{SYM}/1m/{SYM}-1m-{YYYY-MM-DD}.zip(.CHECKSUM|.manifest.json)
data/raw/binance-vision/futures/um/daily/trades/{SYM}/{SYM}-trades-{YYYY-MM-DD}.zip(.CHECKSUM)   # nur Stichprobentage (§4.7)
data/live/{SYM}/{YYYY-MM-DD}/{HH}.csv.zst                                                    # Live-Spool (nur VPS)
```

Klines kommen grundsätzlich aus den Vision-Dumps (Checksum, reproduzierbar, kein API-Gewicht). **Der Importer verlangt je Tag eine Kline-Datei** (ohne sie kein Abgleich, kein Import). Ausnahme für bekannte Dump-Defekte (§4.5): Weicht ein Kline-Dump von den REST-Klines ab und sind die REST-Klines nachweislich gleich dem trades-Dump, wird für diesen Tag REST verwendet und die Herkunft festgehalten (Regel festgelegt; beide bekannten Fälle liegen in Regime A, Umsetzung daher mit P7). Fehlt Menge in der Kline-Quelle selbst (Dump und REST), wird das als Referenzdefekt annotiert, nicht korrigiert.

Downloads: Binance drosselt bei 3 parallelen Downloads, 2 laufen problemlos (gemessen); der Downloader nutzt höchstens 2 und hat Zeitlimits gegen hängende Verbindungen.

Das Manifest besteht aus den Tabellen `raw_file` (eine Zeile je Datei, Primärschlüssel = relativer Pfad unter `data/raw/binance-vision/`, mit `origin` daily/monthly und `period`) und `raw_day` (eine Zeile je Symbol, Art und Tag). Ein JSON-Sidecar je Datei schreibt der Importer auf Anforderung (`--sidecar`/`--sidecar-dir`); das Sidecar einer Monatsdatei enthält die Tageseinträge als Liste, und die Tabellen lassen sich daraus rekonstruieren. Die Felder je Tag sind für beide Herkunftsarten identisch:

| Feld | Inhalt |
|---|---|
| `symbol`, `kind` (aggTrades/klines/trades), `day` | Identität des Tages |
| `origin` (`daily`/`monthly`), `origin_path`, `origin_sha256` | Herkunft: Pfad und geprüfte SHA256 der Tages- bzw. Monatsdatei (bei `monthly` für alle Tage des Monats dieselbe Datei) |
| `bytes`, `sha256`, `checksum_expected`, `checksum_ok` | Integrität der Datei (in `raw_file`) |
| `rows`, `first_agg_id`, `last_agg_id`, `agg_id_holes`, `agg_id_dups`, `ts_backwards` | Vollständigkeit je Tag (bei `monthly` beim Zerlegen abgeleitet); erwartet je 0. Für Monatsdateien zusätzlich: Σ Tageszeilen = Zeilen der Datei, Tage lückenlos 1…n, ID-Bereiche aufeinanderfolgender Tage lückenlos |
| `continues_prev` | `first_agg_id = last_agg_id(Vortag) + 1` |
| `first_ts`, `last_ts` | müssen im UTC-Tag liegen |
| `header_present`, `downloaded_at`, `importer_version` | Herkunft |
| Trade-ID-Sprünge zwischen aggTrades, größte Zeitlücke | **nur Bericht**, nicht Teil der Klassifikation: Loch-IDs sind normal (§4.5), und das Loch vom 2026-10-27 zeigt sich nur hier (Trade-IDs springen um 38 458 bzw. 48 478) und im Kline-Abgleich, nicht in der aggId-Kontinuität |

Live-Spool: der Recorder schreibt jeden empfangenen oder per REST nachgeholten aggTrade im Vision-CSV-Format, gepuffert und **je Sekunde als eigener zstd-Frame** mit fsync. Nach einem Absturz ist höchstens der letzte Frame unvollständig; er wird verworfen und per REST neu geholt. Spool-Dateien werden 7 Tage nach `final_ok` gelöscht.

### 3.2 Symbol-Metadaten und Einheiten

```sql
CREATE TABLE symbol (
  sym_id         smallint PRIMARY KEY,
  name           text UNIQUE NOT NULL,           -- 'BTCUSDT'
  price_unit     numeric NOT NULL,               -- eine Dekade feiner als der Tick bei Aufnahme: BTC 0.01, ETH 0.001
  price_decimals smallint NOT NULL,              -- BTC 2, ETH 3
  tick_ref_units integer NOT NULL,               -- Referenz-Tick in price_unit (BTC 10 = 0,1 $; ETH 10 = 0,01 $)
  qty_unit       numeric NOT NULL,               -- min(stepSize LOT_SIZE, MARKET_LOT_SIZE) bei Aufnahme (BTC/ETH 0.001, aus exchangeInfo)
  qty_decimals   smallint NOT NULL,
  big_floor_n    bigint,                         -- Untergrenze big_order als ganzzahliges Notional (§3.7); Daten, gesetzt mit Migration 0017
  data_from      date NOT NULL,                  -- Beginn der gespeicherten Historie: v1 2026-06-10, nach P7 2025-01-01
  active         boolean NOT NULL DEFAULT true
);
CREATE TABLE symbol_tick_history (               -- empirisch je Tag, exchangeInfo nur Gegenprobe
  sym_id smallint REFERENCES symbol, day date NOT NULL,
  min_step_units integer NOT NULL,               -- ggT aller px-Differenzen des Tages
  PRIMARY KEY (sym_id, day)
);
```

- **Preise** sind Ganzzahlen `px = Preis / price_unit` (int32: BTC bei 0,01 bis ≈ 21 Mio. $). Weil `price_unit` eine Dekade feiner ist als der Tick, übersteht das Schema eine Tick-Verfeinerung ohne Neuimport.
- **Zeilen und Bins** werden in **Ticks** = `tick_ref_units` angegeben; eine Zeile der Größe R Ticks ist `floor(px / (R · tick_ref_units))`. Die UI erlaubt R ≥ aktueller Tick (aus `symbol_tick_history`).
- **Mengen** sind Ganzzahlen in `qty_unit` („Lots").
- **Notional** ist ganzzahlig `n = px · lots` in Einheiten `price_unit · qty_unit` (BTC 10⁻⁵ USDT; eine Order von 100 Mio. USDT = 10¹³, Tagessummen < 10¹⁷, passt in bigint). VWAP und USDT-Werte entstehen erst bei der Ausgabe.
- Ein neues Symbol = eine Zeile `symbol` + Backfill auf dem Mac + Teilübertragung.

### 3.3 Produktregel Minutenzuordnung

**Ein aggTrade gehört vollständig zu der UTC-Minute, in die sein Zeitstempel `T` fällt** (`T` = Zeit seines ersten Fills): `minute_ms = T − (T mod 60 000)`, Tag = `floor(T / 86 400 000)`.

Begründung: aggTrades sind die einzige Quelle in Form des Live-Streams; die Zeiten der einzelnen Fills sind darin nicht enthalten. Die Regel ist in beiden Regimen an Fill-Daten bestätigt (T = erster Fill, Spanne ≤ 100 ms, Straddler nur in die Folgeminute). Folge (gemessen, §4.5): 68–197 aggTrades pro Symbol-Tag haben Fills in der Folgeminute; dadurch weicht unser Minutenvolumen in 12–32 % der Minuten geringfügig von der Binance-Kline ab (Volumen P50 ≈ 0,013 BTC, Maximum 15 BTC in einer Minute). Footprint-Summen und Bar-Volumen sind untereinander konsistent (beide nach dieser Regel); die Kline-Trade-Anzahl wird als Referenzwert separat angezeigt.

### 3.4 Basistabelle: 1 Minute × Preis

```sql
CREATE TABLE fp_1m (
  sym_id smallint    NOT NULL,
  ts     timestamptz NOT NULL,   -- Minutenbeginn (UTC) nach §3.3
  px     integer     NOT NULL,   -- Preis in price_unit
  buy_q  integer     NOT NULL,   -- Lots, Aggressor Käufer (m=false) = „Ask"
  sell_q integer     NOT NULL,   -- Lots, Aggressor Verkäufer (m=true) = „Bid"
  buy_a  integer     NOT NULL,   -- Anzahl aggTrades, Käufer-Aggressor
  sell_a integer     NOT NULL,
  PRIMARY KEY (sym_id, ts, px)
);
SELECT create_hypertable('fp_1m', by_range('ts', INTERVAL '1 day'));
ALTER TABLE fp_1m SET (timescaledb.enable_columnstore, timescaledb.segmentby = 'sym_id', timescaledb.orderby = 'ts, px');
CALL add_columnstore_policy('fp_1m', after => INTERVAL '3 days');
```

Gezählt werden aggTrades, nicht Einzeltrades: `l − f + 1` ist nachweislich keine verlässliche Trade-Anzahl (ID-Löcher ohne Menge innerhalb von aggTrade-Bereichen, §4.5). `integer` reicht für Mengen pro Minute und Preis (Importer prüft Überlauf); Rollups verwenden `bigint`. **Delta = buy_q − sell_q.** Gebaut ohne Standardindex auf `ts` (der Primärschlüssel deckt die Abfragen) und ohne Fremdschlüssel auf `symbol` (Kosten je Zeile beim `COPY`).

Gemessen (BTC): ≈ 874 k `fp_1m`-Zeilen an lebhaften Tagen, ≈ 451 k im Oktober-Mittel (Fassung 2 schätzte 650 k). Columnstore-Faktor 16,4 (120 → 7,3 B/Zeile); Datenbank für 34 BTC-Tage 2 252 MB → 174 MB, also ≈ 4,6–5 MB je BTC-Tag komprimiert. ETH ist noch nicht gemessen.

### 3.5 Bar-Statistik pro Minute

```sql
CREATE TABLE bar_1m (
  sym_id smallint NOT NULL, ts timestamptz NOT NULL,
  open_px integer NOT NULL, high_px integer NOT NULL, low_px integer NOT NULL, close_px integer NOT NULL,
  buy_q bigint NOT NULL, sell_q bigint NOT NULL,
  buy_a integer NOT NULL, sell_a integer NOT NULL,     -- aggTrades
  notional bigint NOT NULL,                            -- Σ px·lots (für VWAP)
  first_agg_id bigint NOT NULL, last_agg_id bigint NOT NULL,
  first_trade_ms bigint NOT NULL, last_trade_ms bigint NOT NULL,
  run_max bigint NOT NULL,   -- Maximum des laufenden Deltas nach jedem aggTrade (Startwert 0 zählt nicht)
  run_min bigint NOT NULL,
  d_from_low  bigint NOT NULL, -- Delta ab (inkl.) dem ERSTEN aggTrade auf low_px bis Minutenende
  d_from_high bigint NOT NULL, -- Delta ab (inkl.) dem ERSTEN aggTrade auf high_px bis Minutenende
  source smallint NOT NULL,    -- 1=live, 2=live+rest, 3=vision
  check_state smallint NOT NULL, -- 0=ungeprüft, 1=exact, 2=shift, 3=mismatch, 4=edge_pending
  PRIMARY KEY (sym_id, ts)
);
-- Hypertable, Chunk 30 Tage, columnstore nach 3 Tagen
```

Minuten ohne Trade haben keine Zeile; die API füllt sie nicht künstlich auf.

**COT nach DeepCharts-Semantik** (entschieden): *COT High* = kumuliertes Delta seit der Bar zuletzt ihr **Low** gebildet hat, bis Close; *COT Low* = seit der Bar zuletzt ihr **High** gebildet hat. Gemessen ab der **Bildung** des Extrems = erster Print auf dem endgültigen Extrempreis; erneutes Antesten desselben Preises verschiebt den Startpunkt nicht. Der bildende aggTrade zählt mit (DeepCharts-Detail nicht öffentlich, eigene Festlegung).

**Komposition auf höhere Zeitrahmen** (Minuten i = 1..n eines Bars, `d_i` = buy_q − sell_q, exklusive Präfixsumme `P_{i−1} = Σ_{k<i} d_k`):

| Größe | Formel | exakt? |
|---|---|---|
| Max Delta | max_i (P_{i−1} + run_max_i) | ja (laufendes Delta ist innerhalb eines aggTrades monoton) |
| Min Delta | min_i (P_{i−1} + run_min_i) | ja |
| COT High | j = **erste** Minute mit low_px_j = Bar-Low: d_from_low_j + Σ_{i>j} d_i | ja |
| COT Low | j = **erste** Minute mit high_px_j = Bar-High: d_from_high_j + Σ_{i>j} d_i | ja |

In SQL per Fensterfunktion (`sum(d) OVER (PARTITION BY bucket ORDER BY ts) − d` = P_{i−1}).

### 3.6 Rollups (explizit gepflegte Tabellen)

Bins in Ticks (`tick_ref_units`); gespeichert wird `row_px = floor(px / (bin·tick_ref_units)) · bin·tick_ref_units`.

| Tabelle | Zeit | Bin | BTC | ETH | Zeilen/Tag BTC / ETH (Schätzung außer fp_1m) |
|---|---|---|---|---|---|
| `fp_1m` | 1m | Preis (1 Tick) | 0,1 $ | 0,01 $ | BTC 451 k (Okt.-Mittel) … 874 k (lebhafte Tage), gemessen / ETH ≈ 290 k (Fassung-1-Messung) |
| `fp_1m_b10` | 1m | 10 | 1 $ | 0,1 $ | ≈ 70 k / 30 k |
| `fp_5m_b10` | 5m | 10 | 1 $ | 0,1 $ | ≈ 29 k / 12 k |
| `fp_15m_b100` | 15m | 100 | 10 $ | 1 $ | ≈ 2 k / 1 k |
| `fp_1h_b10` | 1h | 10 | 1 $ | 0,1 $ | ≈ 10 k / 4 k |
| `fp_1h_b100` | 1h | 100 | 10 $ | 1 $ | ≈ 1 k / 0,5 k |
| `fp_1d_b100` | 1d | 100 | 10 $ | 1 $ | ≈ 200 / 100 |
| `fp_1d_b1000` | 1d | 1000 | 100 $ | 10 $ | ≈ 20 / 10 |
| `bar_1h`, `bar_1d` | 1h, 1d | – | – | – | 24 / 1 |

Gleiche Spalten wie `fp_1m` (Mengen `bigint`). UI-Zeilengrößen liegen auf der Leiter {1, 2, 5}·10^k Ticks, damit jede Zeilengröße ein Vielfaches eines gespeicherten Bins ist. `fp_5m_b10` und `fp_15m_b100` schließen die Lücke bei 15m/30m-Footprints (ohne sie: 370–735 k gelesene Zeilen je Kachel, Review W2).

**Warum explizite Tabellen statt Continuous Aggregates:** Daten ändern sich nur an zwei definierten Stellen (Recorder schließt eine Minute ab; Importer ersetzt einen Tag). Der Importer berechnet alle Rollups eines Tages im selben Lauf und schreibt sie in **derselben Transaktion** wie die Basisdaten – Basis und Rollups sind nie inkonsistent, ein Tag ist atomar ersetzbar, der Rollup-Code ist mit denselben Tests prüfbar. Continuous Aggregates hätten Refresh-Fenster und Invalidierungslogs; Echtzeit-Aggregation ist seit 2.13 standardmäßig aus und bricht bei hierarchischen Stufen an der ersten materialisierten Stufe ab; Max/Min-Delta und COT sind keine einfachen Aggregatfunktionen. Für Live-Minuten aktualisiert der Recorder nach jeder abgeschlossenen Minute die laufenden 5m/15m/1h/1d-Zeilen per Neuberechnung aus `fp_1m` (≤ 60 Minuten, billig).

### 3.7 Orders, Größenverteilung, Big Trades (erst Phase P5)

**Order-Regel v1** (entschieden): aufeinanderfolgende aggTrades (aggId lückenlos +1) mit **gleichem T (ms)** und **gleichem `m`** bilden eine Order. Es gibt keine Order-ID in den Daten; keine Regel ist beweisbar. Gemessene Empfindlichkeit (BTC 2026-11-21):

| Regel | Orders | Notional P50 / P90 / P99 / P99,9 (USDT) | > 5 Mio. |
|---|---|---|---|
| gleiche ms, gleiche Seite (**v1**) | 1,32 Mio. | 1 042 / 30 188 / 238 100 / 1 113 394 | 65 |
| ≤ 100 ms ab erstem aggTrade, gleiche Seite | 0,80 Mio. | 1 898 / 50 982 / 386 450 / 1 718 730 | 135 |

**Entscheidung 2026-11-26 (Nutzer): absolute Schwelle zuerst.** Big Trades werden in v1 über eine **absolute Notional-Schwelle in USDT** bestimmt, die der Nutzer in der UI einstellt (≥ Untergrenze). Das Perzentil-Modell (Größenverteilung `size_hist_*`, Schwellen je Stunde, Zwei-Durchlauf-Untergrenze, unten und §6.4) ist **[später]**. Gespeichert werden nur Orders mit `notional ≥ symbol.big_floor_n`; die Untergrenze ist **Daten** (Tabelle `symbol`, Migration 0017), keine Code-Konstante: BTCUSDT 500 000 USDT (= 5·10¹⁰ in 10⁻⁵ USDT), ETHUSDT 250 000 USDT (= 2,5·10¹¹ in 10⁻⁶ USDT). Big Orders sind Teil des Tages-Digests (eine Wahrheit je Tag, Digest-Version 2, §4.8); alle Tage werden dafür einmal neu importiert.

**Gebaut (Stufen 1–3: Core, Migration 0017, Schreiber):** Die Order-Bildung läuft im gemeinsamen `DayAggregator` (Importer und Recorder rechnen identisch). Je Tag entstehen außer `big_order` die Summen über **alle** Orders, `data_day.orders_n` und `data_day.orders_notional`; je Minute wird geprüft, dass die Orders die aggTrades exakt zerlegen (Σ Notional = `bar_1m.notional`, Σ Lots, Anzahl aggTrades), sonst bricht der Import ab. `data_day.big_floor_n` hält die beim Schreiben verwendete Untergrenze (NULL = keine Untergrenze bekannt, dann keine big orders; der Importer warnt). Der Importer ersetzt `big_order` in der Tagestransaktion, der Recorder minutenweise (Replace) samt absoluter Tagessummen; der Live-/Import-Vergleich der Finalisierung umfasst `big_order` je Minute und die Tagessummen. Gemessen (2026-11-21, unabhängig nachgezählt): BTCUSDT 1 318 662 Orders, 4 257 ≥ 500 000 USDT (0,32 %); ETHUSDT 1 151 258 Orders, 4 626 ≥ 250 000 USDT (0,40 %); Σ Notional Orders = Σ `bar_1m.notional` (Differenz 0).

Die Schwellen hängen also merklich von der Regel ab (P99,9 Faktor ≈ 1,5). Eine verkettete Regel („Abstand zum Vorgänger ≤ x") erzeugte Spannen bis 531 ms und wird nicht verwendet. Unter der v1-Regel kann nur der letzte aggTrade einer Order über T hinausreichen (14,8 % der Mehr-aggTrade-Orders, 0,74 % um > 50 ms). Die Regel ist eine Konstante mit Versionsnummer; ein Wechsel bedeutet Neuberechnung von `size_hist_*` und `big_order` aus dem Archiv auf dem Mac + Teilübertragung.

Größenverteilung: logarithmisch nach Notional, 20 Buckets pro Dekade, k = 0…179 (1 USDT … 10⁹ USDT). Die Grenzen sind je Symbol eine **ganzzahlige Tabelle** `edge_n[k] = round(10^(k/20) USDT / (price_unit·qty_unit))`, versioniert; Zuordnung per Binärsuche auf ganzzahligem Notional – TS-Importer und Python-Verifier sortieren damit bitgleich ein. Genauigkeit: Bucketbreite Faktor 1,122; Ausgabe der geometrischen Bucketmitte ⇒ Fehler ≤ ±5,9 %, log-linear interpoliert meist deutlich weniger. Bei P99,97 über 7 Tage liegen ≈ 2 000 Orders oberhalb – statistisch tragfähig.

```sql
CREATE TABLE size_hist_1m (
  sym_id smallint NOT NULL, ts timestamptz NOT NULL, side smallint NOT NULL,  -- 1=buy, 2=sell
  bucket smallint[] NOT NULL,   -- nur belegte Buckets, aufsteigend
  cnt    integer[]  NOT NULL,   -- Orders je Bucket
  ntl    bigint[]   NOT NULL,   -- Σ Notional je Bucket (für spätere volumengewichtete Perzentile)
  PRIMARY KEY (sym_id, ts, side)
);
CREATE TABLE size_hist_1h (     -- dicht, 180 Einträge, Summe aus size_hist_1m
  sym_id smallint, ts timestamptz, side smallint, cnt integer[] NOT NULL, ntl bigint[] NOT NULL,
  PRIMARY KEY (sym_id, ts, side)
);
CREATE TABLE big_order (
  sym_id smallint NOT NULL, ts timestamptz NOT NULL,          -- T der Order (ms)
  first_agg_id bigint NOT NULL, last_agg_id bigint NOT NULL,
  side smallint NOT NULL,
  px_first integer NOT NULL, px_last integer NOT NULL,        -- Sweep-Spanne
  qty bigint NOT NULL, notional bigint NOT NULL,              -- Lots, ganzzahliges Notional
  agg_n integer NOT NULL,                                     -- gebaut als integer (smallint könnte überlaufen)
  CHECK (last_agg_id - first_agg_id + 1 = agg_n),             -- Regel v1: IDs lückenlos
  PRIMARY KEY (sym_id, ts, first_agg_id)
);
-- gebaut (Migration 0017): big_order mit side 1 = Käufer-, 2 = Verkäufer-Aggressor; size_hist_* [später]
```

**[später] Untergrenze `big_floor_n` aus dem Perzentil-Modell (zwei Durchläufe; bis dahin gilt die absolute Untergrenze oben):** Unterstützt werden nur Schwellen ab dem oberen 1 % der Orders (entschieden: Perzentile ≥ P99). Durchlauf 1 berechnet `size_hist_*` für die gesamte Historie (braucht keine Untergrenze). Daraus: `big_floor_n` = 0,5 × Minimum des stündlichen `rolling7d`-P99 (beide Seiten) über die gesamte Historie, auf eine Bucketgrenze abgerundet. Durchlauf 2 schreibt `big_order` mit `notional ≥ big_floor_n`. Damit liegt jede zulässige Schwelle (≥ P99 in jedem 7-Tage-Fenster und – wegen Faktor 0,5 – mit Reserve auch in `how`/`daysofar`-Fenstern) über der Untergrenze. Der resultierende Anteil gespeicherter Orders wird gemessen und hier nachgetragen (Erwartung: einige Prozent). Fällt eine Schwelle dennoch unter die Untergrenze, markiert die API das Intervall `incomplete`.

### 3.8 Qualität, Referenzdaten, Betrieb

Gebaut (Migrationen 0002–0006; hier nur die Bedeutung, Spaltendetails in `packages/db/migrations/`):

```sql
CREATE TABLE data_day (
  sym_id smallint, day date, PRIMARY KEY (sym_id, day),
  state text NOT NULL,       -- 'provisional' | 'importing' | 'provisional_import_failed' | 'final_ok' | 'final_bad' (§4.3)
  version integer NOT NULL DEFAULT 0,   -- +1 bei jedem Ersatz und jeder Neuklassifikation; Basis der Kachelversionen (§5.4)
  source text,               -- 'live' | 'live+rest' | 'vision'
  raw_sha256 text, kline_sha256 text, rows bigint, first_agg_id bigint, last_agg_id bigint,
  min_exact int, min_shift int, min_mismatch int, min_missing int, min_gap int,
  edge_first_pending boolean, edge_last_pending boolean, edge_pending boolean,   -- Minute 0 / 1439 offen
  carry_q bigint, carry_b bigint, cand_last_q bigint, cand_last_b bigint,        -- Übertrag s(1439) und cand(1439) für den Folgetag
  carry_in_q bigint, carry_in_b bigint, carry_in_origin text,                    -- verwendeter Übertrag s(−1): chain | stored | neighbour | estimated
  prev_last_agg_id bigint,   -- last_agg_id des Vortags, gegen den continues_prev geprüft wurde
  stale boolean NOT NULL DEFAULT false,   -- Eingaben aus dem Vortag haben sich geändert, Neuklassifikation ausstehend
  state_before_import text,  -- für die Wiederherstellung nach Absturz während `importing`
  digest text,               -- Daten-Digest über alle Tabellen (§4.8)
  quality_digest text,       -- Digest der Klassen je Minute (D, s)
  rules_version text, importer_version text,   -- Herkunft; „fertig" hängt NICHT davon ab (§4.1)
  deep_check text,           -- NULL | 'passed' | 'failed' | 'reference_unusable'
  immutable boolean GENERATED ALWAYS AS (state IN ('final_ok','final_bad') AND NOT coalesce(edge_pending, true) AND NOT stale) STORED,
  imported_at timestamptz, verified_at timestamptz,
  orders_n bigint, orders_notional bigint,  -- alle Orders des Tages (§3.7); NULL = ohne Order-Daten geschrieben
  big_floor_n bigint,        -- beim Schreiben verwendete Untergrenze big_order; NULL = keine big orders
  digest_version smallint    -- 1 = zwölf Tabellen (bis P4), 2 = mit big_order und Ordersummen (§4.8)
);
-- geplant (P7): regime ('A' | 'B'), tail_status ('n/a' | 'unverified' | 'repaired'),
--               kline_origin ('vision' | 'rest'), Zeilenquelle 'synthetic' (§4.11)
CREATE TABLE data_minute_issue (
  sym_id smallint, ts timestamptz, kind text,  -- 'shift' | 'mismatch' | 'missing' | 'gap'
  d_q bigint, d_b bigint, cand_q bigint, cand_b bigint, carry_q bigint, carry_b bigint,
  PRIMARY KEY (sym_id, ts, kind)
);
CREATE TABLE kline_1m (      -- Referenz aus Vision-Klines, exakt geparst
  sym_id smallint, ts timestamptz, PRIMARY KEY (sym_id, ts),
  open_px int, high_px int, low_px int, close_px int,
  vol bigint, taker_buy bigint, trades int, quote_vol_n bigint
);
CREATE TABLE ingest_status (component text, sym_id smallint, PRIMARY KEY (component, sym_id),
  last_agg_id bigint, last_trade_ms bigint, ws_connected boolean, open_gaps int,
  unwritten_minutes int, updated_at timestamptz);
CREATE TABLE raw_file ( … Dateifelder wie Manifest §3.1 … );
CREATE TABLE raw_day  ( … Tagesfelder wie Manifest §3.1, PK (sym_id, kind, day) … );
CREATE TABLE verify_run ( run_id serial, host text, started_at timestamptz, scope text,
  checks int, mismatches int, report jsonb );
-- geplant: source_annotation (sym_id, from_ts, to_ts, kind, note) für bekannte Quell- und Referenzdefekte:
--   'aggtrades_hole' | 'kline_dump_defect' | 'kline_source_gap' | 'exchange_outage' | 'trades_dump_lossy'
```

`ingest_status` und die DB-Rollen kommen mit dem Recorder (P3), `size_hist_*`/`big_order` mit P5; `source_annotation` mit dem Abschluss von P1, damit 2026-10-27 in der UI erklärt ist (**offen**).

`kline_1m` ist Referenz- und Anzeigedatum: die **Trade-Anzahl pro Minute kommt aus den Klines** (Stats-Zeile „Trades", auf jedem Zeitrahmen exakt als Summe).

Backup auf dem VPS: täglicher `pg_dump` nur der kleinen Tabellen (`data_day`, `data_minute_issue`, `verify_run`, `raw_file`, `symbol*`) und der Konfiguration; der Mac holt ihn ab. Alles andere ist aus dem Archiv rekonstruierbar.

### 3.9 Kompression und Aufbewahrung

Wie gebaut:

| Tabelle | Chunk | columnstore nach | Retention |
|---|---|---|---|
| `fp_1m` | 1 Tag | 3 Tagen | keine |
| `fp_1m_b10`, `fp_5m_b10` (später `size_hist_1m`) | 7 Tage | 3 Tagen | keine |
| `fp_15m_b100`, `fp_1h_b10`, `fp_1h_b100`, `bar_1m`, `kline_1m` (später `big_order`) | 30 Tage | 3 Tagen | keine |
| `fp_1d_b100`, `fp_1d_b1000`, `bar_1h`, `bar_1d` (später `size_hist_1h`) | 365 Tage | **nicht komprimiert** | keine |
| Live-Spool (VPS) | – | zstd | 7 Tage nach `final_ok` |
| Tagesdateien (VPS) | – | – | 14 Tage |

Die vier Jahres-Tabellen bleiben bewusst unkomprimiert: sie sind winzig (gemessen 1,8 MB roh gegenüber 0,5 MB komprimiert für 34 BTC-Tage), und komprimiert verlangte jeder Re-Import eines historischen Tages die Umwandlung eines ganzen Jahres-Chunks mit exklusiver Sperre über ein Jahr Lesezugriffe. Die Policies greifen nur im laufenden Betrieb; Backfill und Neuberechnung steuern die Kompression selbst (§4.1). Ein Re-Import eines komprimierten Tages wandelt die betroffenen Chunks in den Rowstore, ersetzt und wandelt zurück (§4.3).

### 3.10 Größen (gemessen, wo angegeben)

Basis: ≈ 4,6–5 MB je BTC-Tag komprimiert über alle Tabellen (gemessen an 34 Tagen, §3.4); ETH nicht gemessen (Spanne unten aus der höheren Rohdatengröße abgeleitet).

| Posten | Wert | Status |
|---|---|---|
| Rohdaten aggTrades 2025-01-01…2026-11-23, ZIP | 29,2 GB (BTC 12,9, ETH 16,4) | gemessen (Fassung 2 schätzte 12–14 GB für die Monatsdateien – falsch) |
| Rohdaten Klines 1m, gleicher Zeitraum | 87 MB | gemessen |
| trades-Dump BTC | ≈ 61 MB/Tag | gemessen |
| trades-Dumps für P7 (≈ 525 Tage je Symbol) | 30–50 GB | geschätzt |
| DB v1: BTC ab 2026-06-10 (≈ 167 Tage) | ≈ 0,8 GB | abgeleitet |
| DB, BTC über 692 Tage | ≈ 3,2–4,6 GB | hochgerechnet |
| DB, BTC + ETH über 692 Tage | ≈ 4,6–9,3 GB | hochgerechnet, ETH ungemessen |
| `size_hist_*`, `big_order` (P5) | 0,4–2 GB | geschätzt (Fassung 2) |
| Zuwachs je Jahr, beide Symbole | ≈ 2,5–5 GB | abgeleitet |

VPS-Platte: DB < 10 GB + 14-Tage-Fenster ≈ 1 GB + Spool + Transfer-Spitze → ausreichend für mehrere Jahre. Mac: Archiv ≈ 30 GB, mit P7 zusätzlich 30–50 GB trades-Dumps.

---

## 4. Ingestion und Korrektheit

### 4.1 Historischer Import und Neuberechnung (Mac) – wie gebaut

**Ablauf je Tag** (Tage in Zeitreihenfolge): aggTrades bereitstellen (Tagesdatei oder Tagesanteil der einmal geprüften Monatsdatei, §3.1) und **die Kline-Tagesdatei – ohne sie kein Import**; SHA256 gegen `.CHECKSUM`; streamendes ZIP-Lesen mit CRC32-Prüfung; exakter Ganzzahl-Parser; Aggregation aller Tabellen im Speicher; Abgleich §4.6; Schreiben in **einer** Transaktion (§4.3). Ein angeforderter Tag, dessen Dateien nicht kommen, ist ein **harter Fehler** (nie stiller Erfolg).

**Randminuten:** Jeder Tag wird sofort geschrieben; seine Minute 1439 bleibt `edge_pending`, bis der Folgetag abgeglichen ist, und wird dann entschieden. Minute 0 wird mit dem Übertrag des Vortags entschieden. **Ausnahme per Definition:** Am ersten Tag der gespeicherten Historie gibt es keinen Vortag; seine Minute 0 bleibt dauerhaft `edge_pending`. Nach der gebauten Regel ist dieser eine Tag damit nie `immutable` und wird nicht dauerhaft gecacht – bewusst hingenommen (ein Tag); eine Sonderregel „Historienbeginn gilt als entschieden" ist eine offene Entwicklerentscheidung, keine Nutzerfrage.

**Eingaben und Kaskade:** `data_day` speichert, womit ein Tag klassifiziert wurde (Übertrag s(−1) und dessen Herkunft, `last_agg_id` des Vortags). Wird Tag d neu importiert und ändern sich dadurch diese Eingaben für d+1, klassifiziert derselbe Lauf d+1 neu (Kaskade, endet beim ersten unveränderten Tag); sind die Quelldateien von d+1 nicht verfügbar, wird d+1 als `stale` markiert.

**„Fertig" entscheiden die Daten:** Ein Tag gilt als erledigt, wenn Daten-Digest, Qualitäts-Digest und Eingaben (Quelldatei-Checksummen, Übertrag, Vortags-ID) zum gespeicherten Stand passen – nicht die Code-Version. Eine andere Quelldatei mit identischen Digests zählt als erledigt (Monats- statt Tagesdatei, Mac statt VPS). Semantische Regeländerungen erzwingen eine Neuberechnung ausdrücklich über `RULES_VERSION` (durch einen Test gegen versehentliche Änderung geschützt). Der Digest enthält `check_state` nicht (die Klassifikation hat einen eigenen Qualitäts-Digest).

**Modi und Schalter** (Details im README):

| Schalter | Wirkung |
|---|---|
| Standard / `--db` | Dry-Run (schreibt nichts) / Schreiben in die DB |
| `--backfill` | für mehrtägige historische Läufe: pausiert die Columnstore-Jobs, komprimiert jeden fertigen Chunk selbst, aktiviert die Jobs am Ende; nach einem Absturz repariert der nächste Start die Jobs |
| `--online` | mehrtägiger historischer Lauf ohne Backfill-Modus, wenn Lesersperren je Tag akzeptabel sind. **Ohne `--backfill` oder `--online` lehnt der Importer mehrtägige historische DB-Läufe ab** |
| `--plan` | zeigt nur, was ein Lauf tun würde (nur lesend, kein Lock) |
| `--force` | schreibt auch Tage, die nach den Daten bereits erledigt sind |
| `--prefer auto\|daily\|monthly` | Wahl der aggTrades-Quelle |
| `--direct-dml` | ersetzt komprimierte Tage per DML statt per Rowstore-Umwandlung (nur für Vergleiche; gemessen 7–25 s statt ≈ 2 s je Tag) |
| `--resume`, `--no-neighbours`, `--sidecar` | fertige Tage überspringen / Nachbartage nicht lesen (Randminuten bleiben offen) / Manifest-Sidecar schreiben |

Vor dem Start wird der freie Plattenplatz geprüft (< 15 GB → Abbruch; Regel aus Fassung 2, Umsetzung mit dem VPS-Betrieb zu prüfen).

**Gemessen (Mac):** Dry-Run ≈ 1,2–2 Mio. aggTrade-Zeilen/s, gesamte Historie (2,27 Mrd. Zeilen, beide Symbole) in 31 min; DB-Modus ≈ 0,7–1,0 Mio. Zeilen/s, ≈ 3,3 s je Tag mit 3,5 Mio. Zeilen. Importer-RSS 440–560 MB (Dry-Run-Spitze vor einer Speicherkorrektur bis ≈ 1 GB an den größten Tagen, danach 510 MB im Monatsmodus).

### 4.2 Live-Pfad (Recorder, VPS)

- Je Symbol eine WS-Verbindung `wss://fstream.binance.com/market/ws/<symbol>@aggTrade` (aggTrade liegt seit der Routing-Umstellung 2026 unter `/market`; vom Review gegen die offizielle Change Notice bestätigt). Geplanter Wechsel nach 23 h mit **Überlappung** (neue Verbindung zuerst, Deduplizierung per aggId).
- **Lückenerkennung per aggId.** Gemessen sind aggIds innerhalb und über Tagesgrenzen strikt fortlaufend (0 Löcher, 0 Duplikate). Für den Live-Stream bleibt das die Lückenregel; für die Dumps reicht sie nachweislich nicht (am 2026-10-27 laufen die aggIds über ein echtes Loch hinweg fort, §4.5) – dort entdeckt der Kline-Abgleich Löcher. Regel: erwartet `a = last_a + 1`; bei `a > last_a + 1` wird per REST `GET /fapi/v1/aggTrades?fromId=last_a+1&limit=1000` nachgeholt (Seiten über `fromId`, nie über `startTime`). Liefert REST als erste ID einen Wert > `last_a + 1`, ist bewiesen, dass die fehlenden IDs nicht existieren (wird protokolliert). `a ≤ last_a` → Duplikat, verwerfen.
- REST-Budget: Gewicht 20/Request (laut Vorrecherche), Limit 2 400/min/IP; Recorder hält ≤ 50 % (≤ 25 % im Parallelbetrieb mit PulseBot) ein und wertet `X-MBX-USED-WEIGHT-1M` aus. Nachholen ist ≈ 100× schneller als Echtzeit.
- Lücken älter als 48 h (laut Vorrecherche Fehler −4166, nicht offiziell verifiziert) sind per REST nicht füllbar → Minuten bleiben `gap` (werden **nicht** geschrieben), bis die offizielle Tagesdatei den Tag ersetzt.
- **Minutenabschluss:** Minute M ist abgeschlossen, wenn (a) ein Trade mit T ≥ M + 62 000 ms empfangen wurde oder die (per NTP synchronisierte) Uhr diese Zeit überschritten hat und ein REST-Abruf ab `last_a+1` nichts mit T < M + 60 000 liefert, und (b) keine offene Lücke mit IDs vor diesem Zeitpunkt existiert. Dann wird M **vollständig** in einer Transaktion geschrieben (Replace der Minute, inkl. laufender Rollup-Zeilen). Der formende Bar wird nie persistiert.
- **Wiederanlauf nach Absturz:** Quelle ist die Spool, nicht die DB. Der Recorder liest die letzten vollständigen zstd-Frames der aktuellen und vorigen Stunde, setzt `last_a` auf die letzte gespoolte ID, baut alle Minuten nach der zuletzt committeten Minute (aus `bar_1m`, bei DB-Ausfall aus einem lokalen Commit-Journal) im Speicher neu auf und holt per REST ab `last_a + 1` nach.
- **DB nicht erreichbar:** Recorder spoolt weiter, sammelt abgeschlossene Minuten und schreibt sie nach, sobald die DB zurück ist (Reihenfolge nach Zeit).
- **Ein Rechenweg für abgeschlossene Bars:** Der Recorder sendet nach dem Commit „Minute M committed" über den localhost-Feed; die API liest daraufhin M aus der DB und schickt dem Client diesen Stand. Die API berechnet selbst nur den formenden Bar.
- Feed nur auf 127.0.0.1; die API verbindet sich nie selbst mit Binance.

### 4.3 Tageszustand und Ersatz durch die offizielle Datei

| Zustand | Bedeutung | Wer darf schreiben | Übergänge |
|---|---|---|---|
| (keine Zeile) | – | Recorder legt `provisional` an | → `provisional` |
| `provisional` | Live-Daten, ggf. mit `gap`-Minuten | nur Recorder (minutenweise Replace) | → `importing` (Importer nimmt Advisory-Lock) |
| `importing` | Ersatz läuft | nur Importer | → `final_ok`/`final_bad` (Commit) · → `provisional_import_failed` (Download/Checksum/Parse fehlgeschlagen; Rollback, Live-Daten bleiben) |
| `provisional_import_failed` | Live-Daten, Ersatz steht aus | niemand (Recorder schreibt nicht mehr, Tag ist vorbei) | → `importing` (nächster Timer-Lauf) |
| `final_ok` | offizielle Datei, 0 `mismatch`/`missing` | Importer: nur Randminuten-Entscheid und Neuklassifikation | → `importing` (Neuberechnung) |
| `final_bad` | offizielle Datei, ≥ 1 `mismatch`/`missing` | wie `final_ok` | → `importing` (Neuberechnung); Ops-Alarm über Health |

Zusätzlich zum Zustand (gebaut): `stale` (Eingaben vom Vortag geändert, Neuklassifikation ausstehend), offene Randminuten (`edge_first_pending`, `edge_last_pending`) und `state_before_import` (bei Absturz während `importing` wird der vorige Zustand wiederhergestellt).

**Unveränderlich ist nur, was `immutable` sagt:** `immutable` = `final_*` **und** keine offene Randminute **und** nicht `stale`. Nur solche Tage dürfen in dauerhaft gecachte Kacheln (`final = true`) eingehen. Das ersetzt die Annahme aus Fassung 2, ein `final_*`-Tag ändere sich nur über `importing`: Auch ohne neuen Import ändern Randminuten-Entscheid und Kaskade die Klassifikation (nicht die Daten) eines finalen Tages; jede solche Änderung erhöht `version`.

Regeln:
- **Ersatz nur nach erfolgreicher Checksumme und vollständigem Parse.** Erst dann beginnt die Transaktion: `DELETE` aller Zeilen des Tages in allen Tabellen → `COPY` → Digest-Gegenprobe in der Transaktion (`day_digest_all` = Importer-Digest) → `data_day` (`version + 1`) → Commit. Ein `final_bad` aus einer korrekt geprüften Datei bleibt die Wahrheit (die Datei ist die Quelle; die Abweichung wird gezeigt, annotiert und untersucht).
- **Komprimierte Chunks:** Ersatz über `convert_to_rowstore` → Ersatz → `convert_to_columnstore` (gemessen ≈ 2 s je Tag; direkte DML auf komprimierten Chunks 7–25 s). Das hält für die Dauer der Transaktion eine **exklusive Sperre** auf den betroffenen Chunks; Leser (API) setzen daher `lock_timeout` und wiederholen (Regel für die API, **offen** bis zur API-Implementierung).
- **Single Writer:** Advisory-Lock; der Importer prüft in **jeder** Transaktion erneut, dass er ihn noch hält.
- Der Recorder prüft vor jedem Minuten-Commit in derselben Transaktion `state = 'provisional'` (`SELECT … FOR SHARE`); die DB-Rolle `of_recorder` erzwingt das zusätzlich per Funktion (P3).
- Replace statt Merge: es gibt kein `UPDATE … SET vol = …` auf Level-Ebene.
- Idempotenz: Re-Import erzeugt identischen Digest.
- Timer 07:45 UTC (Datei erscheint beobachtet gegen 07:21 UTC), Wiederholung alle 30 min. Protokolliert wird, wie viele provisorische Minuten exakt mit der offiziellen Datei übereinstimmten (Recorder-Qualitätskennzahl, Ziel ≥ 99,9 %).

### 4.4 Exakte Regeln für Preis, Menge, Seite

**Zeit:** T muss 13-stellig (ms) sein, sonst Abbruch (Schutz gegen µs-Formate wie im Spot-Archiv). Minute nach §3.3.

**Preis/Menge:** nie als Float. Dezimalstring an `.` trennen, Nachkommateil auf `price_decimals` mit Nullen auffüllen (mehr Stellen nur zulässig, wenn die überzähligen `0` sind, sonst Fehler), Ganzzahl bilden; das ist `px`. Gleiches Verfahren für Mengen → Lots. Damit sind „Grenzpreis eine Zeile zu tief" und „Float-Müll als Schlüssel" ausgeschlossen. Zeilenbildung nur per Integer-Division.

**Seite:** `m = true` → Verkäufer ist Aggressor → `sell_q` („Bid"); `m = false` → `buy_q` („Ask").

### 4.5 Befunde zur Datenquelle

**(a) Erstes Experiment** (Fassung 2) – 5 Symbol-Tage (BTCUSDT 2026-11-20/21/22, ETHUSDT 2026-11-21/22), exakte Dezimalrechnung, aggTrades vs. trades-Dump vs. 1m-Klines:

| Befund | Ergebnis |
|---|---|
| Klines entstehen aus den Zeiten der Einzelfills | auf 4/4 vollständigen Tagen stimmen Volumen, Taker-Buy und Trade-Anzahl aller 1 440 Minuten exakt, wenn man Einzeltrades nach eigener Zeit summiert |
| `T` eines aggTrades | = Zeit seines **ersten** Fills (100 %); Fill-Spanne ≤ 100 ms inkl.; gleicher Preis und gleiche Seite; Fill-Zeiten monoton in der ID |
| Straddler (Fills in der Folgeminute) | 68–197 je Symbol-Tag; immer genau zwei benachbarte Minuten; T immer in der früheren Minute, 1–95 ms vor der Grenze; immer Mehrfach-Fill |
| Abweichung bei Zuordnung nach T | alle drei Größen exakt nur in 981–1 265 von 1 440 Minuten; meist winzig (Volumen P50 ≈ 0,013 BTC, max. 15 BTC) |
| nach Verschieben der Straddler-Fills | Volumen und Taker-Buy 1 440/1 440 exakt; Rest nur Tagesrand (letzter aggTrade des Tages mit Fill nach Mitternacht, gespiegelt in Minute 0), mit Nachbartag auflösbar |
| Trade-Anzahl aus `l − f + 1` | **nicht** exakt ableitbar: 64–742 „Loch-IDs" je Tag innerhalb von aggTrade-Bereichen (ohne Menge, in Klines nicht gezählt), 353–1 523 IDs je Tag zwischen aggTrades fehlend; in 35–76 Minuten/Tag übersteigt der ID-Span-Count jede Straddler-Erklärung (bis +402). Was diese IDs sind, ist unbekannt (Insurance-Fund/ADL ist eine Vermutung) |
| aggId-Kontinuität | strikt fortlaufend innerhalb und über Tagesgrenzen, keine rückwärtslaufenden Zeiten |
| trades-Dump-Qualität | BTCUSDT 2026-11-20 ist in den Stunden 19–23 UTC lückenhaft (16 885 fehlende Trade-IDs; 6 019 aggTrades ohne einen ihrer Fills), während Klines und aggTrades das Volumen enthalten. Der trades-Dump ist **nicht** unbedingt zuverlässig |

**(b) Gesamt-Historien-Scan und Fill-Analyse** (nach Fassung 2): Abgleich aller 692 Tage × 2 Symbole (2025-01-01…2026-11-23) und Fill-Analyse an 13 Symbol-Tagen. Die Aussage „aggTrades waren an allen Tagen vollständig" aus (a) gilt **nicht** allgemein:

| Befund | Ergebnis | Status |
|---|---|---|
| **Tail-Verlust bis 2026-06-09** | Die aggTrades-Dumps lassen „Tail-Fills" weg: Fills, die ans Ende eines aggTrades gehören (gleicher Preis und gleiche Seite, Trade-IDs direkt nach dessen letzter ID, Zeit in T…T+100 ms). Klines und trades-Dump enthalten sie. Tages- und Monatsdateien sind darin identisch | bewiesen an 13 Symbol-Tagen; zeitlich eingegrenzt durch den Gesamtscan |
| Umfang | 352 von 692 Tagen je Symbol mit ≥ 1 `mismatch`-Minute; BTC 2 836 `mismatch` + 47 `missing` von 996 480 Minuten, ETH 2 504 + 48; fehlendes Volumen typischerweise 0,02–0,05 % je Tag, bis 0,25 % (2026-06-04), über die Historie ≈ 6 681 BTC. Ein Teil der Tails liegt **innerhalb** der Hülle und bleibt an bestandenen Tagen unentdeckt | gemessen |
| Ende | letzter Fall BTC 2026-06-09 02:35:29.755, ETH 02:04:57.889 UTC; danach 0 Fälle in 5,5 Monaten. Keine Binance-Ankündigung bekannt | gemessen; Ursache offen |
| Minutenregel und Hülle | in beiden Zeiträumen bestätigt (T = erster Fill, Spanne ≤ 100 ms, Straddler nur in die Folgeminute) | bewiesen an Stichproben |
| Defekte Kline-Dumps | 2025-01-14 und 2025-01-29, beide Symbole; Tages- = Monats-Dump; REST-Klines weichen ab und sind gleich dem trades-Dump | bewiesen |
| Lücke in der Kline-Quelle | 2025-03-10 08:21: Dump **und** REST lassen einen zusammenhängenden Block von 812 BTC-Trades weg | bewiesen; nicht korrigierbar, nur annotierbar |
| Börsenausfall | 2025-08-29 06:18–06:37 UTC, echter Ausfall; im ETH-trades-Dump doppelte Trade-IDs | gemessen; bleibt annotiert |
| **Echtes Loch in aggTrades** | 2026-10-27 00:02–00:30 UTC, beide Symbole: aggIds laufen fortlaufend weiter, Trade-IDs springen um 38 458 (BTC) bzw. 48 478 (ETH), 1 298,134 BTC fehlen; im trades-Dump vollständig | bewiesen |

Konsequenzen:
1. **Zwei Regime mit festem Schnitt** (§3.1): v1-Historie ab 2026-06-10; Regime A wird in der eigenen Reparaturphase P7 importiert (Nutzerentscheidung, zweistufig).
2. **Reparaturregel R-A** für Regime A (§4.11); eine reine Kline-Toleranz für Regime A ist verworfen, weil sie auch echte Löcher verdecken würde.
3. **Löcher wie 2026-10-27** sind reparierbar, indem aggTrades aus dem trades-Dump synthetisiert werden (§4.11, kleine Aufgabe in P7; Zeilen als synthetisch markiert).
4. **aggId-Kontinuität erkennt solche Löcher nicht** – der Kline-Abgleich tut es. Trade-ID-Sprünge und Zeitlücken sind reine Berichtsfelder im Manifest.
5. Der trades-Dump kann selbst lückenhaft sein → `reference_unusable` (§4.7).
6. Klines sind nicht mehr ausschließlich Vision: wo der Dump von REST abweicht, wird REST genutzt, sobald es nachweislich gleich dem trades-Dump ist; Referenzdefekte werden annotiert (§3.1).
7. Trade-Anzahl je Minute ist aus ID-Spannen nicht ableitbar (Loch-IDs) und kommt aus den Klines.
8. Tageszustände brauchen für Regime A einen Begriff „Tails nicht geprüft/repariert" (`tail_status`, §3.8, geplant mit P7).
9. Weiter gültig aus (a): Abgleich nur über Volumen und Taker-Buy mit der engen Hülle §4.6; keine Klasse `source_excluded` (die Loch-IDs tragen keine Menge).

### 4.6 Abgleich pro Minute gegen Klines

Für jede Minute m eines Tages (Mengen in Lots, ganzzahlig), getrennt für q = Volumen und b = Taker-Buy-Volumen:

- `D(m) = unser(m) − kline(m)`
- Kandidaten: aggTrades in m mit `l > f` (Mehrfach-Fill) **und** `T mod 60 000 ≥ 59 900`. `cand(m)` = Σ ihrer Mengen (für b nur die mit `m = false`). Nur sie können Menge verschieben, und nur von m nach m+1.
- Verschobene Menge s(m) von m nach m+1 erfüllt `D(m) = s(m) − s(m−1)`. Daraus folgt eindeutig der **Übertrag** `s(m) = s(−1) + Σ_{k≤m} D(k)`, mit `s(−1)` = Übertrag aus der letzten Minute des Vortags (bzw. aus dessen Abgleich).

| Klasse | Bedingung (für q **und** b) |
|---|---|
| `exact` | D(m) = 0 und s(m) = 0 |
| `shift` | nicht exact, aber Hülle `−cand(m−1) ≤ D(m) ≤ cand(m)` **und** Kompensation `0 ≤ s(m) ≤ cand(m)` (die Abweichung ist durch eine nichtnegative, von Kandidaten gedeckte Verschiebung erklärt und wird in der Nachbarminute ausgeglichen) |
| `mismatch` | sonst; danach wird der Übertrag auf [0, cand(m)] begrenzt, damit ein Fehler nicht alle Folgeminuten falsch klassifiziert |
| `missing` | Kline mit Volumen > 0 ohne eigene Zeile oder umgekehrt |
| `edge_pending` | Minute 0 oder 1 439, solange der Nachbartag nicht abgeglichen ist; Minute 0 des ersten gespeicherten Tages bleibt per Definition `edge_pending` (§4.1) |

Der verwendete Übertrag s(−1) wird mit seiner Herkunft gespeichert: `chain` (im selben Lauf berechnet), `stored` (aus `data_day` des Vortags), `neighbour` (Vortag nur gelesen) oder `estimated` (kein Vortag verfügbar). Die Regel ist unverändert gegenüber Fassung 2 und in beiden Regimen an Fill-Daten bestätigt.

Tagessumme: `Σ unser − Σ kline = s(1 439) − s(−1)`, mit beiden Überträgen innerhalb ihrer Kandidatengrenzen – das ist die „exakte Tagessumme bis auf Tagesrand-Straddler". OHLC wird als Bericht verglichen (Abweichungen nur durch Kandidatenpreise zulässig), nicht als Klasse.

Grenzen der Prüfung: Sie ist eine notwendige Bedingung und locker (907–2 273 Kandidaten/Tag gegenüber 68–197 echten Straddlern). Ein Fehler, der Menge aus den letzten 100 ms einer Minute in die Folgeminute verschiebt, könnte maskiert werden – nicht aber ein Off-by-one, der einen aggTrade mit T = k·60 000 in die Vorminute legt (der erzeugt D(m−1) > 0 ohne passenden Übertrag, sobald kein Kandidat ihn zufällig deckt; zusätzlich deckt ihn Test T3 ab). Den vollständigen Beweis liefert die Tiefenprüfung.

Folgen: `final_ok` bei 0 `mismatch`/`missing`, sonst `final_bad` + Ops-Alarm (für Tage mit Annotation eines bekannten Quelldefekts kein erneuter Alarm); bei Live-Daten löst `mismatch` beim Minutenabschluss keinen Alarm aus (Klines des Tages liegen erst am Folgetag vor), sondern erst die Finalisierung bewertet.

### 4.7 Tiefenprüfung gegen den trades-Dump

Stichprobe (deterministisch, Seed im Repo): die ersten 7 Tage der gespeicherten Historie je Symbol (v1: ab 2026-06-10); 2 zufällige Tage je Monat und Symbol; jeder Tag mit `mismatch`; zusätzlich auf Anforderung. Läuft auf dem Mac. Status: die Fill-Analysen hinter §4.5 (b) sind diese Prüfung in Skriptform an 13 Symbol-Tagen; die automatisierte Stichprobe über die v1-Historie ist **offen** (P1).

1. trades-Dump des Tages laden (+ CHECKSUM).
2. **Vollständigkeit der Referenz prüfen:** für jeden aggTrade müssen die Einzeltrades mit ID in [f, l], die im Dump vorhanden sind, in Summe genau seine Menge ergeben, mit gleichem Preis und gleicher Seite (Loch-IDs ohne Menge sind zulässig); zusätzlich Σ Menge je Stunde = Σ Kline-Volumen je Stunde. Jede Stunde, in der das nicht gilt, ist **„Referenz unbrauchbar"**.
3. In den brauchbaren Stunden: Einzeltrades nach eigener Zeit je Minute summieren → muss mit Kline-Volumen, Taker-Buy und Trade-Anzahl **exakt** übereinstimmen (beweist das Kline-Modell).
4. Für jeden Straddler die verschobene Menge s(m) exakt aus den Fill-Zeiten bestimmen und prüfen: `D(m) = s(m) − s(m−1)` exakt für alle Minuten (beweist, dass unsere Minuten exakt der Produktregel entsprechen) und Klasse `shift` aus §4.6 für genau diese Minuten zutreffend.
5. Level-Summen je (T-Minute des Eltern-aggTrades, Preis, Seite) aus dem trades-Dump = `fp_1m` (unabhängige Quelle für die Level-Ebene).

Ergebnis in `data_day.deep_check`: `passed`, `failed` (echter Fehler → Ops-Alarm) oder `reference_unusable` (lückenhafter Dump; **nie** als Datenfehler gewertet; bei Teilbrauchbarkeit gilt `passed` nur für die brauchbaren Stunden, im Bericht ausgewiesen).

### 4.8 Unabhängige Neuberechnung (Verifier) und Digests

Der Verifier (Python, DuckDB) liest die ZIP-Dateien (`zipfile` → pyarrow-CSV → DuckDB) und berechnet unabhängig – **gebaut im Datei- und DB-Modus**; gemessen 2–4,7 GB RSS je Tag, daher auf dem VPS nie parallel zu schweren Abfragen:
- Minutensummen und Level-Summen je (Minute, px) – alle Tage nach Backfill;
- **alle Rollup-Tabellen** und die `bar_1m`-Komposita (Max/Min-Delta, COT) – alle Tage nach Backfill, danach wöchentlich 20 zufällige Tage;
- eine Stichprobe der API-Antworten: ≈ 50 Requests, Binärformat in Python dekodiert, gegen die eigene Rechnung;
- ab P5: Order-Merge, Histogramm-Buckets (ganzzahlig, daher bitgleich), `big_order`.

Jede Abweichung ist ein Fehler (keine Toleranz – beide Seiten rechnen ganzzahlig auf denselben Rohdaten). Einschränkung: Verifier und Importer setzen dieselbe Spezifikation um, vermutlich vom selben Agenten geschrieben; Interpretationsfehler (Seite, Minutenregel) würden sich wiederholen. Diese Lücke schließen die externen Prüfungen: Kline-Abgleich (§4.6) und Tiefenprüfung gegen den trades-Dump (§4.7), die eine andere Binance-Quelle nutzt.

**Digest:** je (Tabelle, Symbol, Tag) SHA256 über die nach Primärschlüssel sortierten Zeilen in kanonischer Textform (SQL-Funktion `day_digest`, Tagesdigest `day_digest_all`; der Importer berechnet dieselbe Textform ohne DB und prüft sie in der Import-Transaktion). `bar_1m.check_state` ist **nicht** enthalten: die Klassifikation ändert sich beim Randminuten-Entscheid ohne Datenänderung; sie hat einen eigenen Qualitäts-Digest. `bar_1m.source` ist enthalten. Verwendet für Idempotenz (K8), „fertig"-Entscheid (§4.1), Transferprüfung (§2.3) und den Mac/VPS-Gleichlauf.

**Digest-Version (ab Migration 0017, `data_day.digest_version`):** Version 1 = die zwölf Tabellen bis P4; Version 2 = zusätzlich `big_order` und die Ordersummen des Tages (`order_day`: `sym_id, day, orders_n, orders_notional, big_floor_n` aus `data_day`). Ein gespeicherter Digest wird immer in **seiner** Version geprüft (`day_digest_all_v`; `day_digest_all` = aktuelle Version): ein vor 0017 geschriebener Tag stimmt in Version 1 weiter überein (kein Fehlalarm in `--verify-db` und Transferprüfung), gilt aber nie als Tag mit Order-Daten (`digest_version = 1`, `orders_n` NULL) und wird vom Importer neu geschrieben (Grund „Digest-Version 1→2"). Digest und Version werden nur gemeinsam gesetzt (Prüfbedingung). Eine geänderte Untergrenze ändert den Digest und führt ebenfalls zum Neuschreiben.

### 4.9 Qualitätsanzeige

`GET /api/v1/quality?sym&from&to` liefert je Tag Zustand, Quelle, Zähler, Tiefenprüfung und Issue-Minuten. Die UI zeigt ein farbiges Band unter der Zeitachse (grün `final_ok`; gelb `provisional`, `provisional_import_failed`, `edge_pending`; rot `gap`, `final_bad`), Tooltip mit Zählern, Markierung betroffener Bars; `shift`-Minuten gelten als korrekt und werden nur im Tooltip gezählt. Annotierte Quelldefekte (§3.8) erscheinen mit ihrer Erklärung statt als unerklärter Fehler; Regime-A-Tage mit `tail_status = unverified` (ab P7) nie grün. Statusbutton: Recorder-Zustand, Datenalter, Health.

### 4.10 Teststrategie

| Test | Art | Inhalt |
|---|---|---|
| T1 Parser | Property | zufällige Dezimalstrings → px/Lots exakt; Off-Grid → Fehler; Rundtrip |
| T2 Zeilenbildung | Property | jeder px in genau einer Zeile; Rebinning aus jedem Bin = direkte Bildung für alle R der Leiter |
| T3 Minutenzuordnung | Unit | T = k·60 000 − 1, k·60 000, k·60 000 + 1, Tagesgrenze; permutierte Eingabe → gleiches Ergebnis |
| T4 Rollup-Äquivalenz | Property | Σ(1m) = 5m = 15m = 1h = 1d; Max/Min-Delta- und COT-Komposition = Brute-Force über aggTrades |
| T5 Klassifikator | Property | synthetische Tage mit eingebauten Straddlern → genau diese Minuten `shift`, Rest `exact`; eingebauter Off-by-one (T = k·60 000 → Vorminute) ohne deckenden Kandidaten → `mismatch`; Tagesrand-Fälle |
| T6 Value Area | Property | enthält POC, zusammenhängend, ≥ va_pct, deterministisch bei Gleichstand |
| T7 Golden Files | Integration | Mini-CSV (≈ 30 handgerechnete Trades inkl. Grenzfälle) im Repo; dazu echte Tage unter `data/` (opt-in `test:golden`, nur lesend), erwartete Minutensummen und Klassifikation im Repo; aufzunehmen: ein Regime-A-Tag mit Tails (erwartet `mismatch`) und 2026-10-27 (erwartet `final_bad`) |
| T8 Idempotenz | Integration | Tag zweimal importieren → identischer Digest |
| T9 Live-Chaos | Integration | WS-Trennung mitten in der Minute, künstliche ID-Lücken, Recorder-Kill inkl. abgeschnittenem zstd-Frame, DB-Ausfall → lückenlos; Vergleich mit offizieller Datei am Folgetag |
| T10 API | Integration | Endpunkte gegen naive Referenzrechnung; zusätzlich Verifier-Stichprobe (§4.8) |
| T11 Render-Performance | Playwright | 25 000 sichtbare Zellen, Frame-Zeit und Long Tasks gegen §1.4 |
| T12 Order-Merge (P5) | Property | Partition der aggTrades; Σ Menge/Notional erhalten |

CI startet eine Timescale-Instanz im Container für die DB-Tests. Prozessregel (neu): Nach jedem Umsetzungsschritt prüft ein separater Agent den Code unabhängig; Commit je Schritt, Push erst nach dem Review.

### 4.11 Reparaturphase für Regime A und Löcher (P7)

**Regel R-A (Tail-Zuordnung):** Ein Fill aus dem trades-Dump zählt genau dann als Tail des aggTrades X, wenn
1. seine Trade-ID in **keinem** aggTrade-Bereich [f, l] liegt,
2. sein Lauf direkt nach der letzten ID von X beginnt (dazwischen nur IDs, die im Dump fehlen),
3. Preis und Seite gleich X sind und
4. T(X) ≤ t ≤ T(X) + 100 ms.

Er wird X zugeschlagen (Menge, Zähler); danach gilt die **unveränderte** Hüllregel §4.6. An den Stichprobentagen bringt R-A die schlechten Minuten auf 0 und erkennt eingebaute Fehler weiterhin (ein gelöschter aggTrade → 1 schlechte Minute; 10-Minuten-Loch → 10–15; das echte Loch 2026-10-27 bleibt bei 29) – bewiesen an Stichproben. Bedarf: trades-Dumps für ≈ 525 Tage je Symbol (geschätzt 30–50 GB, Mac). Verworfen: eine reine Kline-Toleranz für Regime A (würde echte Löcher verdecken).

**Lochreparatur durch Synthese:** Für echte Löcher wie 2026-10-27 werden aggTrades aus dem trades-Dump gebildet (Gruppierung nach Preis, Seite, fortlaufenden Trade-IDs, ≤ 100 ms ab dem ersten Fill; T = erster Fill). Solche Zeilen und Tage tragen die Quelle „synthetisch" (Migration in P7) und bleiben in der UI als repariert erkennbar.

**Zustände in Regime A:** `tail_status` = `unverified` (importiert, nicht repariert; nie als geprüft angezeigt) → `repaired` (R-A angewandt, Abgleich bestanden). Regime B: `n/a`. Für die Defekte aus §4.5 (Kline-Dumps, Kline-Quelle, Börsenausfall) gelten Annotationen; ein Tag, dessen einzige Abweichungen annotierte Referenzdefekte sind, wird als solcher angezeigt, nicht als Datenfehler.

---

## 5. Abfrage- und API-Design

### 5.1 Grundsätze

- Aggregation passiert in Postgres (`GROUP BY` über die passende Rollup-Tabelle); die API rechnet nur, was SQL schlecht kann (Value Area, Schwellen-Perzentile), auf bereits aggregierten Daten.
- Kachelbasierte, binäre, spaltenorientierte Antworten; JSON nur für Metadaten.
- Jeder Endpunkt schätzt vor der Ausführung **Ausgabezellen** (aus `bar_*`: Σ (high − low)/R) **und gelesene Quellzeilen** (Zeilen/Tag der Quelltabelle aus einer täglich gepflegten Statistik × Zeitraum) und lehnt über den Grenzen §1.4 mit `422` + Vorschlag für R ab.

### 5.2 Zeitrahmen und Zeilengröße → Quelle

Zeitrahmen v1: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d. [später] 1w.

Kandidaten sind alle Tabellen, deren Zeitraster tf teilt und deren Bin R teilt. Gewählt wird der Kandidat mit den wenigsten geschätzten Quellzeilen. Nicht ausgerichtete Ränder eines Bereichs (Profile) kommen aus der nächstfeineren Zeitquelle (z. B. Mitte aus 1h, Ränder aus 1m).

Beispiele BTC: 4h, R = 200 Ticks (20 $) → `fp_1h_b100`; 30m, R = 100 Ticks → `fp_15m_b100`; 15m, R = 20 Ticks → `fp_5m_b10`; 1m, R = 5 Ticks → `fp_1m`.

```sql
SELECT time_bucket($tf, ts) AS bar, (row_px / $Rpx) * $Rpx AS row,     -- $Rpx = R·tick_ref_units
       sum(buy_q) AS b, sum(sell_q) AS s, sum(buy_a) AS ba, sum(sell_a) AS sa
FROM fp_15m_b100
WHERE sym_id = $sym AND ts >= $from AND ts < $to
GROUP BY 1, 2 ORDER BY 1, 2;
```

### 5.3 Kacheln

Verbindlich ist [`TILE-FORMAT.md`](TILE-FORMAT.md) (Kachellänge, `/symbols`-Antwort mit `schema`, `tiles[tf][R] = n`, `tileConfigVersion`, Fehlercodes). Die Regel dort ersetzt die Median-Regel aus Fassung 2, weil diese gemessen Kacheln bis 107 000 Zellen ergab:

- Kachel = n Bars, ausgerichtet an Vielfachen von n·tf seit Epoch; n je (Symbol, tf, R).
- `n = clamp(2^floor(log2(30 000 / (1,5 · maxRows))), 32, 1024)`, `maxRows` = größte Zeilenzahl eines Bars dieses tf bei R über die **gesamte gespeicherte Historie**; eine Kombination (tf, R) wird nur angeboten, wenn `32 · 1,5 · maxRows ≤ 60 000`.
- Neuberechnung nach jedem Import; ändert sich ein n, steigt `tileConfigVersion`. Die Version steht als `cfg` in der Kachel-URL, alle Caches sind damit getrennt. Veraltete `cfg` → 409; der Client lädt `/symbols` einmal je Welle neu und zeigt einen roten Hinweis nur bei echter Blockade.
- **Bekannte Schwäche:** ein einzelner Ausreißer-Bar entfernt feine Zeilengrößen für alle Zeiträume. **Offener Entwurfspunkt** (Richtung in TILE-FORMAT.md): Kachellängen und angebotene R je Kalendermonat, Version je (tf, R).

Querprüfung: Der Client prüft jede Footprint-Kachel auf finalen Daten gegen die Bars desselben Bereichs (gleiche Bar-Menge, gleiche buy+sell je Bar) und behandelt Abweichungen wie eine Konfigurationsabweichung (gebaut).

### 5.4 Versionen, Caching, Padding, Abbruch

- **Datenversion:** `data_day.version`. Kachelversion = Hash der Versionen aller überdeckten (Symbol, Tag) + Konfigurationsversion. ETag = Kachelversion.
- Kacheln, die nur `immutable`-Tage überdecken (§4.3), tragen `final = true`, sind unveränderlich (`Cache-Control: immutable`) und liegen im Server-LRU (≤ 200 MB, vorkomprimiert). Alle anderen werden **nie** dauerhaft gecacht (`no-cache`; der Client hält sie bis zur Live-Invalidierung höchstens 60 s).
- Wechselt ein Tag nach `final_*`, pusht die API über den Live-WS ein Invalidierungsereignis (Symbol, Tag, neue Version); der Client lädt betroffene sichtbare Kacheln neu.
- Client: Kachel-Cache, LRU nach Zellzahl (≤ 2 Mio.); sichtbare Kacheln + 1 Kachel Padding je Seite, Prefetch in Panrichtung; höchstens 4 parallele Requests.
- Jeder Request hat einen `AbortController`; verlässt eine Kachel den Bedarf, wird abgebrochen; die API bricht die Query bei Client-Abbruch ab.

### 5.5 Endpunkte

| Endpunkt | Parameter | Liefert |
|---|---|---|
| `GET /api/v1/symbols` | – | Vertrag in TILE-FORMAT.md (`schema`, Einheiten, `dataFrom`/`dataTo`, `tiles`, `tileConfigVersion`) |
| `GET /api/v1/bars` | sym, tf, from, to | Vertrag in TILE-FORMAT.md (ausgerichtete Abschnitte zu 1 000 Bars); Stats-Felder und Kline-Trade-Anzahl später als `x.`-Spalten |
| `GET /api/v1/footprint` | sym, tf, R, tile, cfg | Vertrag in TILE-FORMAT.md |
| Volume Profile (Range, je Tag) | – | Vertrag in `PROFILE-API.md` (entsteht mit P2) |
| `GET /api/v1/tpo` | sym, day, block_min, R, ib_min | §6.5 |
| `GET /api/v1/bigtrades` | sym, tf, from, to, min (USDT) – v1, absolute Schwelle; [später] def, tiers, side_mode | Vertrag in `BIGTRADES-API.md`: Orders ≥ Schwelle (Binärspalten), Abdeckung je Tag (`ok`/`partial`/`none`), Ausdünnung je Bar |
| `GET /api/v1/thresholds` | sym, from, to, def, … | nur Schwellen-Zeitreihe |
| `GET /api/v1/quality` | sym, from, to | §4.9 |
| `GET /api/v1/health` | – | §2.5; nur von localhost erreichbar (nginx leitet ihn nicht nach außen) |
| `WS /api/v1/live` | subscribe {sym, tf, R, features} | formender Bar (Diffs), committed Bars aus DB, Big Trades, Invalidierungen |

Status: die lesende API für `symbols`/`bars`/`footprint` ist **in Arbeit**; bis dahin bedient eine Dev-Middleware Fixture-Kacheln in derselben URL-Form. Zeitparameter in ms UTC, `[from, to)`. Die API hat **ausschließlich lesende Endpunkte**; Import, Neuberechnung, Transfer und jede Wartungsaktion laufen nur per CLI/systemd auf dem Server und sind über HTTP nicht erreichbar.

### 5.6 Binärformat

Festgelegt in [`TILE-FORMAT.md`](TILE-FORMAT.md) (Format 1, gebaut mit Encoder/Decoder und Property-Tests): Magic + Headerlänge, JSON-Header mit Einheiten, spaltenweise Typed Arrays (Little Endian, 8-Byte-ausgerichtet), Level in CSR-Form mit Zeilenindex statt Preis, `x.`-Präfix als Erweiterungspunkt, Invarianten „Footprint-Summen = Bars". ≈ 28 B je Level + 44 B je Bar. Kompression gzip (nginx) bzw. vorkomprimiert aus dem Server-Cache; komprimierte Größe auf echten Daten noch zu messen.

### 5.7 Live-Updates

- Eine WS-Verbindung je Tab; Abo nur für das angezeigte Symbol/tf/R (Wechsel ersetzt das Abo).
- Formender Bar in der API: committed Minuten des laufenden tf-Bars aus der DB + formende Minute aus dem Feed; Level als Map `row → {b,s,ba,sa}` (O(1) pro Trade). Diff höchstens alle 250 ms.
- Nach „Minute M committed" (§4.2) sendet die API M aus der DB.

### 5.8 Messungen der Abfragen (Mac, warm, echte BTC-Daten, 34 Tage)

| Abfrage | Quelle | Zeit |
|---|---|---|
| 1m-Kachel, 256 Bars | `fp_1m_b10` | 1,5 ms |
| 5m-Kachel, 1 024 Bars | `fp_5m_b10` | 22 ms |
| Profil über den Oktober | `fp_1h_b100` | 2,2 ms |
| Profil über einen Tag | `fp_1m` | 5,8–23,6 ms |
| Range-Profil über 2,5 Tage | `fp_1m` | 41 ms |
| Planungszeit bei 34 Chunks | – | 0,6–3,7 ms |

Folgerung: Abfragen brauchen **konstante Zeitgrenzen** (Literale bzw. Parameter, keine Ausdrücke wie `now()`), damit Timescale Chunks schon beim Planen ausschließt. Kalt-Werte und VPS-Werte stehen aus (M1).

---

## 6. Feature-Spezifikationen

Referenzen: **DC** = DeepCharts (öffentliche Doku, Formeln teils unbekannt), **TV** = TradingView. TV rechnet seinen Footprint standardmäßig aus Intrabars und leitet die Seite aus deren Richtung ab; unser Footprint nutzt das Aggressor-Flag und darf daher vom TV-Standard abweichen.

### 6.1 Footprint

Spalte „Stand": **gebaut** (gegen Fixture-Daten) oder Phase, in der es kommt.

| Element | Definition | Default | Referenz | Stufe | Stand |
|---|---|---|---|---|---|
| Zeile | `floor(px / (R·tick_ref_units))`, R aus Leiter {1,2,5}·10^k Ticks, R ≥ aktueller Tick, nur angebotene (tf, R) (§5.3) | auto | TV/DC | v1 | gebaut |
| Auto-R | lesbarkeitsorientiert, nur am Gestenende/Resize/Laden; Regeln in §7.2. **Nie beim Pannen** | §7.2 | eigen (TV: 0,2 × ATR, unbestätigt) | v1 | gebaut |
| R manuell | Ticks pro Zeile in Toolbar und URL; wird nie still überschrieben | – | TV/DC | v1 | gebaut |
| Gitter an Bar-Open verankert | – | aus | DC | später (nur aus `fp_1m`) | – |
| Typ Bid×Ask | links sell, rechts buy | – | TV/DC | v1 | gebaut |
| Typ **Delta** | eine Zahl je Zeile b − s; Farbe nach Vorzeichen, Intensität nach Betrag | **Default** | TV/DC | v1 | gebaut |
| Typ Volume | b + s | – | TV/DC | v1 | offen (P4) |
| Typ Delta + Volume | Delta links, Volumen rechts | – | DC | v1 | offen (P4) |
| Modus Box | Zahl in gefärbter Zelle | Box | DC/TV | v1 | gebaut |
| Modus Profile im Footprint | horizontaler Balken je Zeile (Länge ∝ Wert / Max im Bar) | – | DC/TV | v1 | offen (P4) |
| Zelleingabe | Volumen oder **Anzahl aggTrades** (nicht DCs Trade-Anzahl; Einzeltrade-Zahlen pro Level sind aus aggTrades nicht exakt ableitbar) | Volumen | DC | v1 | Volumen gebaut, aggTrade-Anzahl offen (P4; Daten liegen in der Kachel) |
| Hover | exakte Lots, Preisintervall der Zeile, Bar-Zeit | an | – | v1 | gebaut |
| Mehrere Spalten pro Bar (bis 4) | – | – | DC | später | – |
| Ladder, dynamische Schriftgröße, Cluster-Umrisse | – | – | TV/DC | später | – |
| Formender Bar | live | an | – | v1 | offen (P3) |

Ebenfalls v1, aber noch nicht gebaut (alle P4): Imbalance und Stacked Imbalance, POC, Delta-POC, Value Area je Bar, High/Low Ratio, Farbmodi außer dem gebauten Verlauf.

**Farbskalierung:** Intensität = min(1, |Wert| / Ref), Ref = 95. Perzentil der |Werte| im Bereich (Default sichtbare Bars; Option pro Bar), neu berechnet am Gestenende und beim Laden, nicht pro Frame. Farbmodi v1: aus, fest, Verlauf; [später] Mehrfarb-Bänder, „nur dominante Seite", Färbung nach Imbalance/Dominant-Delta.

**Imbalance** (ganzzahlig, `ratio_pct` z. B. 300):
- Innere Zeilen ohne Trades zählen als 0; Zeilen außerhalb [Low, High] existieren nicht.
- Diagonal (Default): Buy-Imbalance in Zeile i, wenn `100·b_i ≥ ratio_pct·s_{i−1}` und `b_i − s_{i−1} ≥ minDiff`; Sell-Imbalance in Zeile i, wenn `100·s_i ≥ ratio_pct·b_{i+1}` und `s_i − b_{i+1} ≥ minDiff`.
- Randzeilen: Buy-Imbalance in der untersten und Sell-Imbalance in der obersten Zeile gibt es nur mit `includeZero` (Vergleichszeile fehlt).
- Gegenseite = 0: zählt nur mit `includeZero` (dann nur die minDiff-Bedingung, b_i > 0 vorausgesetzt).
- Horizontal (Option): `b_i` vs. `s_i`.
- Defaults: ratio 300 % (TV-Default laut Vorrecherche, unbestätigt), minDiff 0, includeZero aus. [v1]
- **Stacked:** ≥ 3 lückenlos benachbarte Zeilen mit Imbalance derselben Seite (eine Zeile ohne Imbalance oder ohne Trades bricht die Folge) → Zone [Unterkante unterste, Oberkante oberste Zeile], nach rechts projiziert bis ein späterer Bar in die Zone handelt. [v1]

**POC / Delta-POC / Value Area je Bar:**
- POC = Zeile mit max. Volumen; Gleichstand → näher an der Mitte des Bar-Ranges, dann die tiefere. [v1]
- Delta-POC = Zeile mit max. |Delta|, Vorzeichen per Farbe (entschieden; DC-Formel nicht auffindbar). [v1]
- **Value Area** (einheitlich für Bars, Profile, TPO): Start bei POC; Summe der zwei nächsten Zeilen oberhalb vs. Summe der zwei nächsten unterhalb (fehlt eine Seite, nur die andere; am Rand ggf. eine Zeile); das größere Paar wird aufgenommen, Gleichstand → oben; bis kumuliert ≥ va_pct (Default 70 %). Das ist das klassische Market-Profile-Verfahren; ob TV identisch rechnet, ist unbestätigt (TV nennt nur Ziel 70 % und VAH/VAL als äußerste Zeilen). [v1]
- Anzeige: POC als Zellrahmen, VA als schmaler Balken am Bar-Rand. [v1]

| Weiteres | Definition | Stufe |
|---|---|---|
| High Ratio | b(oberste−1) / b(oberste); nur bei ≥ 3 Zeilen und Nenner > 0, sonst „–" | v1 |
| Low Ratio | s(unterste+1) / s(unterste) | v1 |
| Footprint-Single-Prints, Bar Ratio, Effort | DC-Formeln nicht öffentlich | entfällt in v1 (entschieden) |
| Absorptionszonen | – | nice |
| Volumenbalken nach Körper/Docht | Volumen der Zeilen innerhalb [open, close] vs. außerhalb | nice |

### 6.2 Stats-Grid (unter dem Chart, an Bars ausgerichtet)

| Zeile | Formel | Stufe |
|---|---|---|
| Volume, Buy, Sell | b + s, b, s | v1 |
| Delta, Delta % | b − s, (b − s)/(b + s) | v1 |
| Max Delta / Min Delta | §3.5 | v1 |
| Trades | Σ Kline-Trade-Anzahl der Minuten (Binance-Referenz) | v1 |
| aggTrade-Delta | buy_a − sell_a (ersetzt DCs „Trade Delta", dessen Einzeltrade-Seiten aus Klines nicht verfügbar sind) | v1 |
| Tages-CVD | Σ Delta seit Tagesgrenze (§6.3) | v1 |
| COT High / COT Low | §3.5 (DC-Semantik) | v1 |
| High/Low Ratio | §6.1 | v1 |
| Volume/Sekunde | Volumen / Bar-Dauer (formender Bar: verstrichene Sekunden) | v1 |
| Bar-Dauer, Bar Ratio, Effort | – | später / entfällt |

Schattierung je Zeile: z = (x − μ)/σ über die sichtbaren Bars, Intensität min(1, |z|/3); optional feste Hervorhebungsschwelle je Zeile. [v1] LOD: Text ab bs ≥ 30 px, darunter nur Schattierung, unter 4 px ausgeblendet.

### 6.3 Volume Profile (Phase P2, direkt nach der API)

Prioritätsänderung des Nutzers: gemeint war ursprünglich „Volume Profile mit Delta", nicht nur der Delta-Footprint. Das Volume Profile (Custom Range + je Tag; Ansichten Total / Buy-Sell / Delta) kommt deshalb direkt nach der API und vor dem Stats-Grid. Der Endpunkt-Vertrag steht in `PROFILE-API.md` (entsteht gerade, wird hier nicht spezifiziert).

| Element | Definition | Default | Stufe |
|---|---|---|---|
| Custom Range | Zeitbereich per Ziehen (§7.5), `[t0, t1)` auf Minuten gerundet | – | v1 |
| Tagesprofile | je Tag, links am Tagesbeginn, Breite = Tagesbreite × 0,8 | an bei tf ≤ 1h | v1 |
| Tagesgrenze | UTC 00:00; Offset in ganzen Stunden (entschieden); 1d-Rollups nur bei Offset 0, sonst 1h-Rollups | 0 | v1 |
| Zeilen | eigenes R, **unabhängig vom Footprint-R** (POC/VA von Profil und Bars dürfen daher abweichen); auto ≈ 120 Zeilen (Range) bzw. ≈ 60 (Tag) | auto | v1 |
| Darstellung | Total; Buy/Sell; Delta | Total | v1 (alle drei in P2) |
| POC, VAH, VAL | §6.1, va_pct 70 % | an | v1 |
| Linien verlängern | bis Chartende oder nächstes Profil | aus | v1 |
| Naked POC, Wochen-/Monatsprofile | – | – | später |

### 6.4 Big Trades (Phase P5)

**Einheit:** Order nach §3.7; Position = (Bar-Zeit, VWAP der Order). Tooltip zeigt Notional, Menge, Preisspanne, Anzahl aggTrades, Perzentilrang; die Fill-Zahl wird mit „≈" gekennzeichnet (Order-Regel ist heuristisch).

**Schwelle [v1] (Entscheidung 2026-11-26):** absolut in USDT, in der UI einstellbar, nicht unter `big_floor_n` des Symbols (BTCUSDT 500 000, ETHUSDT 250 000 USDT); Tage mit `digest_version < 2` haben keine Order-Daten und werden so angezeigt.

**[später] Perzentil-Schwellen** aus `size_hist_1h`, nach Anzahl Orders, log-linear interpoliert; Seiten gemeinsam (Default) oder getrennt; nur Perzentile p ≥ 99 wählbar:

| `def` | Referenzfenster für Stunde h | Parameter | Default |
|---|---|---|---|
| `rolling7d` | Stunden [h − 168, h) | p | **Default**, p = 99,9 |
| `how` (gleiche Stunde der Woche) | Stunden h − 168·k, k = 1…N | N, p | N = 4 |
| `daysofar` | [Tagesbeginn, h); in der ersten Stunde des Tages der gesamte Vortag | p | – |

Die Schwelle ist stückweise konstant je Stunde; ein Trade wird gegen die Schwelle **seiner** Stunde geprüft (kein rückwirkendes Umfärben). Am Datenbeginn (erste 7 Tage für `rolling7d`, erste N Wochen für `how`) ist das Fenster unvollständig → `incomplete`. Kosten über ein Jahr ≈ 18 k Zeilen × 2 × 180 Werte (≈ 25 MB) – in P5 messen; Schwellenreihen werden je (Symbol, def, Parameter) gecacht.

**Stufen:** Low ≥ S(99,5), Medium ≥ S(99,9), Strong ≥ S(99,97) (entschieden; Anlehnung an DCs Low/Medium/Strong, dort statisch). **Darstellung:** Kreis, r = clamp(3 px · √(N / S_low), 3 px, 18 px), Deckkraft 0,45/0,7/0,95, Buy/Sell-Farbe, Größen-Label ab Medium [v1]; hohl/gefüllt, Formen [später].

**Umschaltbar ohne Verwirrung:** Legende zeigt Definition, Perzentil und aktuelle Schwelle („7T-P99,9 · aktuell ≥ 1,42 Mio. $"); optionale Schwellen-Stufenlinie als Stats-Zeile; beim Umschalten Hinweis „Marker im Bereich: 142 → 97"; Auswahl wird lokal gespeichert; `incomplete`-Intervalle schraffiert.

### 6.5 TPO (eigene Ansicht, Phase P6)

| Element | Definition | Default | Stufe |
|---|---|---|---|
| Periode | Tag (Grenze wie §6.3) | Tag | v1; Woche/Monat später |
| Blockgröße | 5/10/15/30/60 min | 30 min | v1 |
| Buchstaben | Block i → A–Z, a–z; bei > 52 Blöcken i mod 52 | – | v1 |
| TPO-Zeilen eines Blocks | Block-Low/High = min low / max high aus `bar_1m`; Zeilen `floor(low/Rpx) … floor(high/Rpx)` | – | v1 |
| Zeilengröße | Leiter; auto ≈ 40 Zeilen je Tagesrange | auto | v1 |
| POC | Zeile mit meisten TPOs; Gleichstand → näher an Range-Mitte | – | v1 |
| Value Area | §6.1-Verfahren auf TPO-Zählung | 70 % | v1 |
| Initial Balance | Range der ersten **ib_min Minuten** (unabhängig von der Blockgröße) | 60 min | v1 |
| Single Prints | Zeilen mit genau 1 TPO, außer oberster/unterster Zeile | an | v1 |
| Poor High/Low | oberste/unterste Zeile mit ≥ 2 TPOs | an | v1 |
| Volumenprofil daneben | Tagesprofil §6.3 | an | v1 |
| Split/Merge, Custom Sessions | – | – | später |

---

## 7. Frontend und Rendering

### 7.1 Bibliotheksnutzung (lightweight-charts 5.x)

| Teil | Umsetzung |
|---|---|
| Footprint | **Custom Series** `FootprintSeries`: Datenitem je Bar `{time, open, high, low, close, li}` (li = Index in Level-Typed-Arrays); `priceValueBuilder` → [low, high, close]; Renderer zeichnet nur sichtbare Bars/Zeilen |
| Kerzen bei Zoom-Out | Candlestick-Series auf denselben Daten |
| Profile, Big Trades, Zonen, POC-Linien | Series-Primitives (Profil angelehnt an das offizielle `volume-profile`-Beispiel) |
| Stats-Grid | zweites Pane, Custom Series `StatsGridSeries` → automatisch zeitsynchron |
| Qualitätsband | Pane-Primitive |
| TPO | eigene Canvas-Ansicht (§7.4) |

Lizenz: Apache-2.0 mit Attributionspflicht → Hinweis im UI. `lightweight-orderflow-charts` (MIT) nur nach Lizenzprüfung der konkreten Version als Code-Quelle; flowsurface und aggr (GPL) nur als Verhaltensreferenz. Conflation (seit 5.1, standardmäßig aus) für die Kerzenansicht bei vielen Bars.

### 7.2 Level-of-Detail-Regeln

Wie gebaut (`apps/web`, Regeln aus Nutzerrückmeldung „Zeilen viel zu fein"). `bs` = Bar-Abstand (px), `rh` = Zeilenhöhe (px), `vc` = geschätzte sichtbare Zellen.

| Stufe | Bedingung | Darstellung | Daten |
|---|---|---|---|
| L3 Zahlen | bs ≥ 44 (Delta) bzw. ≥ 80 (Bid×Ask), rh ≥ 11, vc ≤ 25 000 | Text in Zellen | Level |
| L2 Zellen | bs ≥ 6, rh ≥ 2, vc ≤ 25 000 | gefärbte Zellen | Level |
| L1 Kerzen | sonst | Kerzen | nur `bars` |

Wechsel in den bzw. aus dem Footprint-Modus mit 10 % Hysterese.

**Zeilenklasse:** „Text", wenn bs ≥ 44 px (Delta) bzw. 80 px (Bid×Ask); verlassen wird sie erst unter 0,9 × Schwelle; sonst „Zellen".

**Auto-R** (nur am Gestenende, bei Resize und beim Laden; nie während einer Geste):
1. Das aktuelle R bleibt, solange rh im Halteband liegt (Text 11,5–44 px, Zellen 3–16 px) und vc ≤ 25 000.
2. Sonst wird unter den angebotenen R mit rh ≥ Klassenminimum (Text 11,5 px, Zellen 4 px) dasjenige gewählt, dessen rh auf logarithmischer Skala dem Ziel am nächsten liegt (Text 14 px, Zellen 6 px).
3. Danach wird R so lange vergrößert, bis vc ≤ 22 500.

Manuelles R (Toolbar, URL) wird nie still überschrieben; passt es nicht, fällt die Ansicht auf eine gröbere Stufe zurück. Beim R-Wechsel zeichnet das bisherige R weiter, bis das neue geladen ist.

**Standardansicht:** bs = Text-Schwelle × 1,05 (bei 1 600 px Breite ≈ 32 Delta-Kerzen bzw. 17 Bid×Ask-Kerzen mit Zahlen), Preis automatisch skaliert. Gemessen ergeben sich so ≈ 5–7 Zeilen je Kerze: bei ≈ 35 Kerzen ist die sichtbare Preisspanne ≈ 7× die Spanne einer Kerze; mit ≈ 20 Kerzen wären es ≈ 7, mit ≈ 12 Kerzen 9–10 Zeilen (Geometrie, abgeleitet). Ob standardmäßig weniger Kerzen gezeigt werden sollen, ist eine **offene Produktfrage an den Nutzer** (§10.3).

**Gemessen** (Chromium, Dev-Build, Fixture-Daten, 25 ms simulierte Latenz): Frame-Arbeit p95 ≤ 2,7 ms, max ≤ 4,2 ms, 0 Long Tasks, ≤ 22 440 sichtbare Zellen, Renderer-Prozess ≈ 270 MB, erster Footprint ≈ 210–280 ms.

### 7.3 Zustand und Zeichnen (gegen die PulseBot-Probleme)

- Chartdaten in **nicht-reaktiven** Typed Arrays (`DataStore`-Modul); Svelte-`$state` nur für UI-Einstellungen (Symbol, tf, Typ, R-Modus, …), `$state.raw` wo nötig.
- Beim Laden einer Kachel einmalig berechnet und abgelegt: Farb-Referenz-Beiträge, Imbalances, Stacked-Zonen, POC/VA je Bar, **vorformatierte Text-Strings** der Zellen.
- `setData` nur bei Kachel-Ankunft bzw. tf-Wechsel; Live per `series.update()`. Obergrenzen: Footprint-Modus ≤ 5 000 Bars, Kerzen-Modus ≤ 20 000 Bars (setData mit 50 k Kerzen kann > 50 ms dauern); darüber erzwingt die UI einen größeren Zeitrahmen.
- Alle Overlays zeichnen in den Renderern der Bibliothek; kein separates, bei jeder Crosshair-Bewegung neu gezeichnetes Overlay-Canvas. Tooltips als DOM, per `requestAnimationFrame` gebündelt.
- Live-Diffs gepuffert, höchstens einmal pro Frame (max. 4/s).
- Server-/Seiten-Abweichung (gebaut): `/symbols` trägt `schema`; die Kachel-URL trägt `cfg`; 409 → ein Neuladen von `/symbols` je Welle; roter Hinweis nur bei echter Blockade (Vertrag in TILE-FORMAT.md).
- UI-Grundstruktur v1: Toolbar (Symbol, tf, Typ, R), Einstellungsdialog, Tooltips, Zustand in der URL (Symbol, tf, Ausschnitt, Profile).

### 7.4 TPO-Ansicht

Eigenes Canvas: x = Tage (Spalten fester Breite, ≤ 30 sichtbar), y = Preis (gemeinsame Skala, Zoom/Pan), je Tag Buchstabenmatrix, POC/VA/IB markiert, optional Volumenprofil rechts. LOD: Zellhöhe < 9 px → farbige Blöcke statt Buchstaben. Fertige Tage unveränderlich gecacht.

### 7.5 Custom-Range-Auswahl

Werkzeug „Profil": Ziehen im Chart markiert [t0, t1) (Snap auf Bar-Grenzen), nach Loslassen ein `profile`-Request; Profil als Primitive verankert, in der URL gespeichert, mehrere möglich, löschbar. Alternativ Eingabe per Datum/Uhrzeit (UTC). Während des Ziehens nur ein Rechteck, kein Request.

---

## 8. Ausbauphasen

Aufwand in Personentagen (PT), eine Person mit KI-Unterstützung. Reihenfolge (entschieden): **zuerst ein vertikaler Schnitt mit BTCUSDT**, der Datenkorrektheit und Performance auf dem VPS beweist; danach Volume Profile (Prioritätsänderung des Nutzers), Live-Betrieb und der Rest; die Reparatur der Historie vor 2026-06-10 ist eine eigene Phase. Prozess: unabhängiges Code-Review durch einen separaten Agenten nach jedem Umsetzungsschritt, Commit je Schritt, Push nach dem Review. PulseBot läuft bis P3 weiter.

Stand 2026-11-24. Bereits verbrauchter Aufwand wird nur qualitativ angegeben.

| Phase | Inhalt | Abnahmekriterien | Stand | PT |
|---|---|---|---|---|
| **P0 Grundgerüst** | Monorepo, Datenbank (lokal OrbStack, Image gepinnt), Migrationsrunner, CI | `npm test` grün; Schema per Migration reproduzierbar | **erledigt** | 2–3 (verbraucht) |
| **P1 Vertikaler Schnitt BTCUSDT ab 2026-06-10** | (a) Importer mit Abgleich, Kaskade, Digests, Backfill-/Online-Modus; (b) Verifier Datei-/DB-Modus, Tiefenprüfungs-Stichprobe; (c) Schema 0001–0006; (d) Backfill BTC 2026-06-10…2026-11-23; (e) lesende API `symbols`/`bars`/`footprint` nach TILE-FORMAT.md; (f) Frontend: Footprint-Renderer Delta + Bid×Ask mit LOD, Zellbudget, Auto-R, Querprüfung; (g) Transfer auf den VPS; (h) Benchmark kalt/warm auf dem VPS; (i) `source_annotation` für 2026-10-27 | Manifest: Checksums ok, aggIds über alle Tage fortlaufend; **100 % der Minuten `exact` oder `shift`, 0 `mismatch`, 0 `missing`** außer dem annotierten Loch 2026-10-27 (bleibt `final_bad` bis P7); Tagessummen exakt bis auf Tagesrand-Straddler; Tiefenprüfung `passed` auf allen Stichprobentagen mit brauchbarer Referenz (`reference_unusable` dokumentiert, nicht als Fehler); Verifier 0 Abweichungen inkl. Rollups und API-Stichprobe; Re-Import digest-gleich; Monats- = Tagesdatei-Digest an 3 Tagen (Monatserster, Monatsletzter, ein weiterer); Transfer digest-gleich, VPS-Platte nie mit unkomprimierter Basistabelle; Benchmarks kalt **und** warm innerhalb §1.4 für 1m-Footprint feinstes angebotenes R, 15m-Footprint über 3 Monate pannen, 4h-Footprint über die ganze v1-Historie, 1h-Kerzen über die ganze v1-Historie; T11 grün | **teilweise**: erledigt (a), (b) ohne automatisierte Stichprobe, (c), (f) gegen Fixtures; in Arbeit (d), (e); offen (g), (h), (i), Stichprobe | 15–20 (großer Teil verbraucht) |
| **M1 – erstes sichtbares Ergebnis** | echter BTC-Footprint (Delta-Ansicht) auf dem VPS im Browser, geprüfte Daten, gemessene Budgets | – | offen | – |
| **P2 Volume Profile** | Range-Profil + Tagesprofile, Ansichten Total / Buy-Sell / Delta, POC/VAH/VAL; Vertrag `PROFILE-API.md`; Range-Werkzeug | Profilsummen = Verifier; Budgets §1.4 kalt/warm; Sichtvergleich an 3 Stichproben | offen (Vertrag entsteht) | 6–8 |
| **P3 Live-Betrieb + ETH** | ETH-Backfill + Teilübertragung; Recorder, tägliche Finalisierung auf dem VPS, formender Bar, Health + healthchecks.io, DB-Rollen, Backup, Mac/VPS-Gleichlauf; PulseBot + mongod stoppen | wie Fassung 2: 72-h-Lauf ohne unentdeckte Lücke; provisorische Tage ≥ 99,9 % identisch mit der offiziellen Datei; E-Mail-Alarm ≤ 15 min; 7 Tage unbeaufsichtigt; Restore-Probe | offen | 8–11 |
| **P4 Footprint komplett + Stats-Grid** | Typen Volume, Delta+Volume, aggTrade-Anzahl, Profile-Modus, Imbalances, Stacked, POC/Delta-POC/VA, Ratios, Farbmodi, Stats-Grid mit LOD | Budgets bei 25 000 sichtbaren Zellen; Komposita = Verifier; Sichtvergleich mit TV an 3 Stichproben | offen | 9–12 |
| **P5 Big Trades** | wie Fassung 2 (§3.7, §6.4) | wie Fassung 2 | offen | 6–8 |
| **P6 TPO** | `tpo`, TPO-Ansicht | Property-Tests (VA, IB, Single Prints); 30 Tage flüssig | offen | 4–6 |
| **P7 Historien-Reparatur 2025-01-01…2026-06-09** | trades-Dumps ≈ 525 Tage/Symbol laden (30–50 GB, Mac); R-A in Importer und Verifier; `tail_status`, `kline_origin`, synthetische Zeilen (Migration); REST-Klines für die defekten Kline-Dumps; Annotationen; Lochreparatur 2026-10-27; Import beider Symbole; Teilübertragung | alle Regime-A-Tage `repaired` mit 0 `mismatch` außer annotierten Referenzdefekten; eingebaute Fehler werden weiterhin erkannt (Tests wie §4.11); 2026-10-27 nach Synthese `final_ok`; `data_from` = 2025-01-01 | offen | 6–10 |
| **Puffer** | Performance-Tuning, VPS-Härtung, Review-Runden, Unvorhergesehenes (≈ 15 %) | – | – | 8–11 |
| **Summe** | | | | **≈ 64–89** |

Gegenüber Fassung 2 (57–78 PT) kommen P7 und der Review-Aufwand hinzu.

---

## 9. Risiken

| Risiko | Auswirkung | Gegenmaßnahme |
|---|---|---|
| Footprint-Kacheln auf dem VPS langsamer als auf dem Mac (Mac-Werte gemessen, §5.8; VPS kalt offen) | Budgets verfehlt | Benchmark ist P1-Abnahme; Optionen: weitere Rollup-Stufe, kleinere Kacheln, mehr `shared_buffers` nach Stopp von PulseBot |
| Mac/VPS-Abhängigkeit für Neuberechnungen | Regeländerung erfordert Mac + Transfer | Teilübertragung chunkweise (§2.3); Neu-Download von Binance als Rückfall |
| Transfer komprimierter Chunks per `pg_dump` verhält sich anders als erwartet | Plattenspitze auf dem VPS | Vorab-Test an Test-DB; Rückfall: Teilübertragung chunkweise für alle Tage |
| Binance ändert Routing/Formate/Dateiangebot | Live-Ausfall, fehlende Tagesdateien | Health + Totmann; Endpunkte konfigurierbar; Archiv auf dem Mac |
| trades-Dumps häufiger lückenhaft | Tiefenprüfung oft `reference_unusable`; R-A in P7 für betroffene Tage nicht anwendbar | wird gezählt; Kline-Abgleich bleibt als Prüfung; zusätzliche Stichprobentage; nicht reparierbare Tage bleiben `unverified` |
| Binance ändert das Dump-Verhalten erneut (wie zum Regimewechsel 2026-06-09) oder Dumps bekommen weitere Löcher | unbemerkt unvollständige Daten | Kline-Abgleich jedes Tages ist die Wache (nicht die aggId-Kontinuität); Trade-ID-Sprünge als Bericht |
| Rowstore-Umwandlung sperrt Chunks exklusiv | API-Abfragen blockieren während eines Ersatzes | `lock_timeout` + Wiederholung in der API; Ersatz nachts; Jahres-Tabellen unkomprimiert |
| Ausreißer-Bar entfernt feine Zeilengrößen (Kachelregel) | grobe Footprints in ruhigen Zeiträumen | offener Entwurfspunkt O2 |
| Verifier-Speicherbedarf (2–4,7 GB je Tag) | VPS-Speicher knapp | Verifier auf dem VPS nur nachts und nie parallel zu schweren Abfragen; Hauptlauf auf dem Mac |
| Order-Regel liefert andere Größen als DeepCharts | andere Schwellen | Empfindlichkeit dokumentiert (§3.7); Regel versioniert und neu berechenbar |
| DC-Definitionen unvollständig | Abweichungen zu DeepCharts | eigene Definitionen explizit (§6) |
| Plattenplatz VPS durch Spool/WAL/Transfer | Ausfall | Health-Prüfung ≥ 10 GB frei; Importer-Abbruch < 15 GB |

---

## 10. Entscheidungen und offene Fragen

### 10.1 Festgelegt

| Thema | Entscheidung |
|---|---|
| Quelle der Wahrheit | aggTrades von Binance Vision (Betrieb: Tagesdateien; Erstimport: Monatsdateien, nach Tag zerlegt), mit Regime-Schnitt 2026-06-10 (§3.1); Minute nach T (§3.3) |
| Validierung | Volumen + Taker-Buy gegen Klines mit enger Hülle; Trade-Anzahl nur Referenz; Tiefenprüfung auf Stichprobentagen |
| Rohdaten/Berechnung | Archiv auf dem Mac (+ Backup), Historie auf dem Mac berechnet und übertragen, VPS mit 14-Tage-Fenster |
| Reihenfolge | vertikaler Schnitt BTC zuerst (§8) |
| COT | DeepCharts-Semantik (§3.5) |
| Big Trades | **2026-11-26:** zuerst absolute USDT-Schwelle (in der UI einstellbar), gespeichert ab `symbol.big_floor_n` (BTCUSDT 500 000, ETHUSDT 250 000 USDT, Daten); Teil des Tages-Digests (Version 2); Order-Regel v1 „gleiche ms + Seite + fortlaufende ID"; ganzzahliges Notional; [später] Perzentile ≥ P99 (Default `rolling7d` P99,9, Stufen 99,5/99,9/99,97) mit Untergrenze per Zwei-Durchlauf |
| Tagesgrenze | UTC 00:00, Offset in ganzen Stunden |
| Delta-POC, DC-Elemente ohne Formel | max. \|Delta\|; Single Prints/Bar Ratio/Effort entfallen in v1 |
| PulseBot | wird mit P3 (Live-Betrieb) gestoppt (inkl. mongod) |
| Historie | zweistufig: v1 ab 2026-06-10 (Regime B); Reparatur von 2025-01-01…2026-06-09 inkl. Loch 2026-10-27 als eigene Phase P7 |
| Feature-Reihenfolge | Volume Profile mit Delta-Ansicht direkt nach der API (P2), vor Stats-Grid und restlichem Footprint |
| Entwicklungsumgebung | lokale DB in OrbStack (Docker Desktop abgelehnt); Node 24.22.3 per nvm; Python 3.14 im Verifier-venv, 3.12 in CI |
| Prozess | unabhängiges Code-Review durch einen separaten Agenten nach jedem Schritt; Commit je Schritt, Push nach dem Review |
| Weitere Symbole | später; Kosten je Symbol ab 2025 ≈ 15–25 GB Rohdaten (Mac) + 2–5 GB DB |
| Ops-Alarm | E-Mail an den Nutzer über healthchecks.io-Totmann; Fallback ntfy |
| Zugriff | v1 öffentlich über HTTPS, **ohne Passwort** (§10.2) |

Offene Messgrößen: Kalt- und VPS-Werte (M1), ETH-Größen, Anteil `big_order` über die ganze Historie (2026-11-21 gemessen: BTC 0,32 %, ETH 0,40 % der Orders, §3.7), Transferverhalten von `pg_dump`, komprimierte Kachelgröße. Offene Fragen siehe §10.3.

### 10.2 Zugriff (entschieden)

v1 ist **öffentlich über HTTPS erreichbar, ohne Passwortschutz**. Begründung des Nutzers: der VPS ist ein persönliches Pilotprojekt, Last durch Fremde ist unerheblich, ein Verlust des VPS hätte keine ernsten Folgen.

Beibehalten werden Schutzmaßnahmen, die kein Passwort sind und fast nichts kosten. Sie sollen niemanden aussperren, sondern **die App schnell und die Datenbank sicher halten**:
- Postgres nur auf `127.0.0.1` bzw. Unix-Socket (Docker-Portfreigaben umgehen UFW, daher nie `5432:5432`).
- API mit nur lesender DB-Rolle; die API hat keine schreibenden oder administrativen Endpunkte. Import, Neuberechnung, Transfer und Wartung laufen ausschließlich per CLI/systemd auf dem Server.
- Die Guards pro Request (Quellzeilen ≤ 1,5 Mio., Zellen ≤ 30 000/60 000, §5.1) und ein einfaches Rate-Limit je IP in nginx (`limit_req`, `limit_conn`).
- `/api/v1/health` und der Recorder-Feed sind nur lokal erreichbar.

Marktdaten-Weitergabe: Binance Vision hat eigene Nutzungsbedingungen (PDF auf data.binance.vision), deren Text sich in dieser Sitzung nicht auslesen ließ; ein inoffizieller Beitrag im Binance-Entwicklerforum hält öffentliche Marktdaten für allgemein nutzbar. Verbindlich geprüft ist das nicht – kein Blocker für ein privates, öffentlich erreichbares Pilotprojekt, aber vor einer Weitergabe an Dritte oder kommerziellen Nutzung zu lesen.

[später, falls gewünscht] Login: eine echte Login-Seite mit einem festen Passwort, das der Browser speichern kann; Passwort als argon2id- oder bcrypt-Hash in der Datenbank; Session-Cookie `HttpOnly`, `Secure`, `SameSite=Strict`; die API prüft das Cookie auch beim WS-Upgrade. Kein HTTP-Basic-Auth.

### 10.3 Offene Fragen

| # | Frage | an | Empfehlung |
|---|---|---|---|
| O1 | Standardansicht: weniger Kerzen zeigen? Heute ≈ 32 Delta-Kerzen bei 1 600 px mit ≈ 5–7 Zeilen je Kerze; ≈ 20 Kerzen ergäben ≈ 7, ≈ 12 Kerzen 9–10 Zeilen (§7.2) | Nutzer | an M1 mit echten Daten ausprobieren; Vorschlag: Ziel ≈ 20 Kerzen (bs ≈ 75–80 px im Delta-Typ) als Standard, Zoom bleibt frei |
| O2 | Kachellänge je Kalendermonat statt über die ganze Historie (§5.3, TILE-FORMAT.md) | Entwickler | vor P3 entscheiden, spätestens wenn ein Ausreißer feine R entfernt; erst nach P7 dringend (längere Historie) |
| O3 | Erster Tag der Historie: Minute 0 dauerhaft `edge_pending` und Tag nie `immutable` (§4.1) – Sonderregel oder hinnehmen? | Entwickler | hinnehmen bis P7; mit P7 verschiebt sich der Historienbeginn ohnehin |
| O4 | Zeitpunkt von P7 (30–50 GB Download, 6–10 PT) | Nutzer | nach P4, sobald die ältere Historie für Profile/Vergleiche gebraucht wird |

---

## 11. Änderungen gegenüber Fassung 1

| Bereich | Änderung | Grund |
|---|---|---|
| Minutenregel (§3.3, §4.5) | Hypothese durch Messergebnis ersetzt; Zuordnung nach T als explizite Produktregel | Experiment: T = erster Fill, Straddler belegt; Nutzerentscheidung |
| Abgleich (§4.6) | `shift` nur über Kandidaten (Mehrfach-Fill, T mod 60 000 ≥ 59 900), nur Vorwärtsverschiebung, Hülle + Übertrag-Kompensation; Count-Toleranz und 10-%-Regel gestrichen; `edge_pending` | Review B1 (a–c, e); Experiment |
| Trade-Anzahl | nicht mehr aus `l − f + 1`, nicht mehr Prüfgröße; Anzeige aus Klines; Level-Zähler = aggTrades | Experiment: Loch-IDs; Review B1 (d) |
| Tiefenprüfung (§4.7) | neu: trades-Dump mit vorheriger Vollständigkeitsprüfung, `reference_unusable` | Review B1.1; Experiment (lückenhafter Dump); Nutzerentscheidung |
| P1-Abnahme | „100 % exact/shift, 0 mismatch, Tiefenprüfung bestanden" statt „≥ 99 % exact" | Review B1.3; Nutzerentscheidung |
| Backfill/Kompression (§4.1, §3.9) | Backfill-Modus mit pausierten Policies, chunkweiser expliziter Kompression, Platzprüfung | Review B2.1/B2.2 |
| Mac/VPS (§2.3) | Archiv und Historienberechnung auf dem Mac, Transferverfahren (Erst- und Teilübertragung, Digests), VPS-Fähigkeiten ohne Mac | Nutzerentscheidung (F1); Review B2.3 |
| Big Trades (§3.7, §6.4, §8) | nach P5 verschoben; ganzzahliges Notional und ganzzahlige Bucketgrenzen; Untergrenze per Zwei-Durchlauf (0,5 × min. stündliches 7T-P99); gemessene Empfindlichkeit der Order-Regel; nur p ≥ 99; `incomplete` am Datenbeginn | Review B3, H5; Experiment; Nutzerentscheidung |
| `quote_vol` | durch ganzzahliges `notional` ersetzt | Review B3 (b) |
| COT (§3.5) | DeepCharts-Semantik, ab Bildung des Extrems, Komposition über die erste Extrem-Minute | Review W1; Nutzerentscheidung |
| Rollups (§3.6, §5.2) | `fp_5m_b10`, `fp_15m_b100` ergänzt; Quellenwahl nach geschätzten Quellzeilen | Review W2 |
| Guards/LOD (§5.1, §5.3, §7.2) | Quellzeilen-Guard, zellbasierte Kachellänge, Budget sichtbarer Zellen, vorformatierter Text, Stats-Grid-LOD | Review W3 |
| Zustandsautomat (§4.3) | vollständige Tabelle inkl. `importing`, `provisional_import_failed`; Ersatz erst nach Checksum + Parse; `gap`-Minuten werden nicht geschrieben; Recovery aus der Spool mit zstd-Frames; committed-Events statt doppelter Bar-Berechnung | Review W4 |
| Cache-Versionen (§5.4) | `data_day.version`, Kachelversion, keine Caches für provisorische Tage, Invalidierungsereignis | Review W5 |
| Einheiten (§3.2) | `price_unit` eine Dekade feiner als der Tick, Zeilen in Ticks, empirische Tick-Historie, `qty_unit` = min(LOT_SIZE, MARKET_LOT_SIZE), R ≥ Tick | Review W6 |
| Verifier (§4.8) | Umfang inkl. Rollups, Komposita, API-Stichprobe; ZIP über `zipfile`/pyarrow; Grenzen der Unabhängigkeit benannt | Review W7 |
| Order-Regel | Empfindlichkeit gemessen statt Nutzerfrage; „≈" im Tooltip | Review W8; Experiment |
| Monitoring (§2.5) | systemd-Watchdog, Health-Endpunkt mit Platten-/NTP-/Unit-Prüfungen, Ping nur bei `healthy`, Fail-Ping; healthchecks.io (Gratis-Tarif geprüft) mit E-Mail, Fallback ntfy | Review W9; Nutzerentscheidung |
| Exposition (§2.4, §5.5) | Postgres nur auf 127.0.0.1/Socket, DB-Rollen, Secrets 0600, gzip statt Brotli, nginx-Rate-Limit je IP, nur lesende öffentliche Endpunkte | Review W10 |
| Backup/Restore (§3.8, §8) | Klines aus Vision statt REST, Backup kleiner Tabellen, Archiv-Prüfung monatlich, Restore-Probe als P2-Abnahme | Review W11 |
| Phasen (§8) | vertikaler Schnitt BTC zuerst, Meilenstein M1, Aufwand 57–78 PT inkl. Puffer und UI-Grundstruktur | Review W12; Nutzerentscheidung |
| Monatsdateien (§3.1, §4.1, §8) | für den Erstimport der Historie gelten die bereits geladenen, checksum-geprüften Monatsdateien (2025-01 … 2026-10) als gleichwertige Quelle: Sie werden beim Streamen nach UTC-Tag zerlegt und danach exakt wie Tagesdateien behandelt. Das Manifest führt Herkunft und Tageswerte je Tag (`raw_day`). Der Betrieb und das VPS-Fenster nutzen nur Tagesdateien. Neues P1-Kriterium: digest-gleicher Import aus Monats- und Tagesdatei an 3 Tagen | Ein erneuter Download von ≈ 1 300 Tagesdateien mit denselben Daten wäre Verschwendung; H1 ist damit eingeschränkt umgesetzt (im Betrieb ein Codepfad, für die Historie ein Zerlegeschritt plus einmaliger Nachweis) |
| Hinweise | Tagesdateien als Betriebsquelle (H1, siehe Zeile Monatsdateien); Imbalance-Ränder, ganzzahlig, Stacked-Lücken (H2); IB in Minuten, TPO-Zeilen per floor (H3); Profil-R unabhängig (H4); columnstore-API und gepinntes Image (H6); `effective_cache_size` gesenkt, kalt/warm-Budgets (H7); Kerzen-Obergrenze 20 k (H8); REST-Gewicht im Parallelbetrieb, −4166 als unverifiziert markiert (H9); Lizenzprüfung `lightweight-orderflow-charts` vor Nutzung (H10) | Review H1–H10 |
| Unbestätigte TV-Angaben | VA-Paarverfahren, Imbalance-Default 300 %, Auto-R 0,2 × ATR als unbestätigt markiert | Review Abschnitt 3 |
| Zugriff (§10.2) | entschieden: v1 öffentlich ohne Passwort; nur kostenlose Schutzmaßnahmen für Leistung und DB-Sicherheit; Login nur als „später, falls gewünscht" (echte Login-Seite, Passwort-Hash, sicheres Session-Cookie); Hinweis zu Binance-Weitergabebedingungen | Nutzerentscheidung |

**Nicht oder anders übernommen:**
- *B1.2 (Count muss im `shift` exakt aufgehen, Count-Abweichung ≤ Σ(l − f)):* nicht übernommen – die Trade-Anzahl ist aus aggTrades nachweislich nicht exakt ableitbar (Loch-IDs bis +402 je Minute), sie würde korrekte Minuten als Fehler melden. Stattdessen wird die Count-Gleichheit der Klines in der Tiefenprüfung bewiesen.
- *B1.4 (Klasse `source_excluded`):* nicht nötig – Volumen und Taker-Buy gehen nach Verschieben der Straddler vollständig auf; die fehlenden IDs tragen keine Menge.
- *B2.3 (Backfill auf dem VPS mit Löschen nach Import):* nicht übernommen, da der Nutzer Mac-Berechnung + Transfer entschieden hat; die Alternative des Reviews (Transfer per `pg_dump` mit pre/post-restore) ist umgesetzt.
- *W8 (Fehlerquote der Order-Regel gegen den trades-Dump messen):* teilweise – auch der trades-Dump enthält keine Order-ID, ein „Match-Ereignis" daraus wäre ebenfalls eine Heuristik. Stattdessen ist die Empfindlichkeit gegenüber der Alternativregel gemessen und dokumentiert; die Regel ist versioniert und neu berechenbar.
- *W10 / E6 (Basic-Auth bzw. VPN, WS-Auth-Prüfung):* nicht übernommen – der Nutzer hat entschieden, v1 öffentlich ohne Passwort zu betreiben; Basic-Auth ist ausdrücklich ausgeschlossen. Die übrigen W10-Punkte (Port-Bindung, Rollen, Secrets) sind übernommen.
- *W2:* beide vorgeschlagenen Stufen übernommen (nicht nur eine), weil 15m und 30m sonst unterschiedlich gut bedient würden.

---

## 12. Änderungen gegenüber Fassung 2

| Bereich | Änderung | Grund |
|---|---|---|
| Datenquelle (§3.1, §4.5) | Aussage „aggTrades-Dumps vollständig" ersetzt: zwei Regime mit Schnitt 2026-06-10; Tail-Verlust bis 2026-06-09 belegt und beziffert; Kline-Dump-Defekte, Lücke in der Kline-Quelle, Börsenausfall, echtes aggTrades-Loch 2026-10-27 dokumentiert | Fill-Analyse an 13 Symbol-Tagen und Gesamtscan 692 Tage × 2 Symbole |
| Historie (§1.5 K11, §3.2, §8) | v1-Historie ab 2026-06-10; Reparatur von Regime A als eigene Phase P7 | Nutzerentscheidung (zweistufig) |
| Reparatur (§4.11) | neu: Regel R-A für Tails, Lochreparatur durch Synthese aus dem trades-Dump, `tail_status`, synthetische Zeilenquelle; Kline-Toleranz für Regime A verworfen | an Stichproben bewiesen; Toleranz würde echte Löcher verdecken |
| Lückenerkennung (§1.5 K6, §3.1, §4.2) | aggId-Kontinuität erkennt Dump-Löcher nicht; Wache für die Historie ist der Kline-Abgleich; Trade-ID-Sprünge und Zeitlücken nur Berichtsfelder | 2026-10-27: aggIds fortlaufend über das Loch |
| Klines (§3.1) | nicht mehr ausschließlich Vision: REST bei nachweislich defektem Dump (wenn gleich dem trades-Dump); Referenzdefekte annotiert; Importer verlangt je Tag eine Kline-Datei | defekte Kline-Dumps 2025-01-14/29; Lücke in der Kline-Quelle 2025-03-10 |
| Annotationen (§3.8, §4.9) | geplante Tabelle `source_annotation` | Quelldefekte sichtbar erklären statt wegrechnen |
| Rohdaten/Größen (§2.3, §3.4, §3.10) | Rohdaten 29,2 GB gemessen (Fassung 2: 12–14 GB, falsch); `fp_1m` 451–874 k Zeilen/BTC-Tag gemessen; Faktor 16,4 (7,3 B/Zeile); ≈ 4,6–5 MB je BTC-Tag; Hochrechnungen neu; trades-Dumps für P7 30–50 GB; Downloads höchstens 2 parallel | Messungen |
| Kompression (§3.9) | Chunk-Intervalle wie gebaut; vier Jahres-Tabellen unkomprimiert | winzig; vermeidet jahresweite exklusive Sperre beim Re-Import |
| Importmodell (§4.1, §4.3, §4.8) | Tag sofort schreiben, Minute 1439 beim Folgetag entscheiden; Eingaben in `data_day`, Kaskade bzw. `stale`; „fertig" nach Daten statt Code-Version, andere Quelldatei mit gleichen Digests = fertig; `RULES_VERSION`; `immutable` als einzige Basis für Dauer-Caches (ersetzt „final ändert sich nur über importing"); Ersatz über Rowstore-Umwandlung mit exklusiver Sperre → Leser mit `lock_timeout` + Wiederholung; `--backfill`/`--online` Pflicht für mehrtägige historische Läufe; `--plan`; Lock je Transaktion geprüft; fehlender Tag = harter Fehler; Digest ohne `check_state`, eigener Qualitäts-Digest | wie gebaut (Migrationen 0005/0006, Importer), Reviews N2–N6 |
| Erster Historientag (§4.1, §4.6) | Minute 0 bleibt per Definition `edge_pending`; der Tag ist damit nie `immutable` (offene Entwicklerfrage O3) | Folge der gebauten Regel, ausdrücklich gemacht |
| Messungen Import/Verifier (§4.1, §2.1) | Durchsatz, Laufzeit Gesamt-Dry-Run, RSS von Importer und Verifier | gemessen; Verifier-Speicher begrenzt seinen Einsatz auf dem VPS |
| Kachellänge (§5.3) | Regel aus TILE-FORMAT.md (Maximum über die ganze Historie × 1,5, Angebot nur bis 60 000), `schema`/`cfg`/409, Querprüfung Kachel gegen Bars; Schwäche und offener Entwurfspunkt „je Kalendermonat" | Median-Regel ergab gemessen bis 107 000 Zellen |
| API (§5.5, §5.6, §5.8) | Verträge in TILE-FORMAT.md bzw. `PROFILE-API.md` referenziert statt hier spezifiziert; Mac-Messungen der Abfragen; konstante Zeitgrenzen für Chunk-Ausschluss beim Planen | gebaut bzw. gemessen; Doppelspezifikation vermeiden |
| Auto-R, LOD, Standardansicht (§6.1, §7.2) | lesbarkeitsorientierte Zeilenwahl mit Haltebändern, Zielhöhen und Zellbudget 22 500; Zeilenklassen mit Hysterese; manuelles R nie still überschrieben; altes R zeichnet bis das neue geladen ist; Standard-Bar-Abstand = Schwelle × 1,05; Messwerte des Renderings; Kerzenzahl der Standardansicht als offene Produktfrage | Nutzerrückmeldung „Zeilen viel zu fein"; Messung im Browser |
| Footprint-Status (§6.1) | Spalte „Stand": gebaut sind Delta, Bid×Ask, Box, Volumen-Eingabe, Hover; v1 aber offen (P4): Volume, Delta+Volume, aggTrade-Anzahl, Profile-Modus, Imbalance, VA, POC/Delta-POC, Ratios | ehrlicher Stand |
| Phasen (§8) | neue Reihenfolge: P1 Schnitt (teilweise erledigt) → M1 → P2 Volume Profile → P3 Live + ETH → P4 Footprint + Stats → P5 Big Trades → P6 TPO → P7 Reparatur; Stand je Phase; Aufwand ≈ 64–89 PT | Prioritätsänderung des Nutzers (Volume Profile mit Delta), zweistufige Historie, Review-Prozess |
| Entscheidungen (§10) | OrbStack, Node/Python-Versionen, Prozessregel Review, Historie zweistufig, Feature-Reihenfolge; offene Fragen O1–O4 | Nutzerentscheidungen und gebauter Stand |
| Big Trades (§3.7, §4.8, §6.4, §10.1) | absolute USDT-Schwelle zuerst, Perzentil-Modell und Zwei-Durchlauf-Untergrenze [später]; Untergrenze je Symbol als Daten (BTC 500 000, ETH 250 000 USDT); `big_order` gebaut (Migration 0017, `agg_n integer`); Ordersummen und verwendete Untergrenze in `data_day`; Digest-Version 2 mit Prüfung je gespeicherter Version | Nutzerentscheidung 2026-11-26; gebaut und an 2026-11-21 gemessen |
