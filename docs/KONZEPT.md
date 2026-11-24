# orderflow-binance – Konzept

Stand: 2026-11-24 · Fassung 2 · Status: **Entwurf zur Freigabe** (noch kein Anwendungscode)

Dieses Dokument ist die verbindliche Grundlage für Implementierung und Review. Änderungen am Konzept werden hier nachgezogen, bevor Code entsteht, der davon abweicht. Kennzeichnung: **[v1]** = erste Ausbaustufe, **[später]** = geplant, nicht v1, **[nice]** = nur wenn billig. „(unbestätigt)" markiert Angaben über Fremdprodukte, die nicht aus offizieller Doku belegt werden konnten. Fassung 2 arbeitet das Review (`KONZEPT-REVIEW.md`), ein Datenexperiment und Entscheidungen des Nutzers ein; Übersicht in §11.

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

### 1.5 Korrektheitsgarantien

| # | Garantie | Wie erzwungen |
|---|---|---|
| K1 | Jeder Tag mit Status `final_*` stammt aus der offiziellen Binance-Tagesdatei mit geprüfter SHA256 | Manifest; Ersatz erst nach Checksum + vollständigem Parse (§4.3) |
| K2 | Preise werden ohne Gleitkommafehler auf Ganzzahlen abgebildet | Integer-Parser (§4.4) |
| K3 | Mengen und Notional werden exakt summiert | Ganzzahlige Lots und ganzzahliges Notional (§3.2) |
| K4 | Pro Minute stimmen Volumen und Taker-Buy-Volumen mit der Binance-1m-Kline überein oder die Abweichung liegt nachweislich in der engen Minutengrenzen-Hülle (`shift`); Tagessummen exakt bis auf Tagesrand-Straddler | Abgleich nach jedem Import (§4.6) |
| K5 | Auf Stichprobentagen ist bewiesen, dass die Klines exakt aus den Einzelfills folgen und unsere Minuten exakt der Produktregel entsprechen | Tiefenprüfung gegen den trades-Dump (§4.7) |
| K6 | Keine unbemerkten Lücken | aggId-Kontinuität, Tagesstatus, Health + Totmann (§2.5, §4.2) |
| K7 | Eine Minute wird vollständig oder gar nicht geschrieben; nie partiell, nie von zwei Schreibern | Zustandsautomat + Single Writer + Replace (§4.3) |
| K8 | Aggregate sind reproduzierbar | Re-Import erzeugt identische Tages-Digests; Mac und VPS vergleichen Digests (§2.3, §4.8) |
| K9 | Unabhängige Zweitberechnung stimmt überein | Python/DuckDB-Verifier inkl. aller Rollups und API-Stichprobe (§4.8) |
| K10 | Die UI zeigt jederzeit, wie verlässlich die angezeigten Daten sind | Qualitätsband + Statusendpunkt (§4.9) |

---

## 2. Architektur

### 2.1 Prozesse

| Prozess | Aufgabe | Läuft | Schreibt |
|---|---|---|---|
| `recorder` | WebSocket aggTrade je Symbol, Lückenerkennung + REST-Nachholen, Spool-Dateien, fertige Minuten als provisorisch in die DB, lokaler Trade-Feed für die API | VPS, Daemon (`Type=notify`) | Basistabellen nur für Tage im Zustand `provisional`; `ingest_status` |
| `importer` | Download Tagesdateien (aggTrades + Klines; Erstimport zusätzlich Monatsdateien, §3.1), Checksum, Manifest, Tagesaggregation, atomarer Tages-Ersatz, Abgleich; Backfill-Modus | Mac: Historie/Neuberechnung; VPS: tägliche Finalisierung (Timer) | Aggregate für Tage im Zustand `importing`; `raw_file`, `data_day`, `data_minute_issue`, `kline_1m` |
| `api` | HTTP (Binärdaten), WebSocket (formender Bar), Health-Endpunkt, Big-Trade-Schwellen | VPS, Daemon | nichts (DB-Rolle nur lesend) |
| `web` | statisches Frontend (Svelte 5 + lightweight-charts) | nginx (VPS), Vite (Mac) | – |
| `verifier` | unabhängige Neuberechnung (Python + DuckDB), Tiefenprüfung gegen trades-Dump | Mac; leichter Lauf auf VPS | nur `verify_run` |
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
| Rohdaten | vollständiges Archiv ab 2025-01-01 (aggTrades + Klines, trades-Dumps nur für Stichprobentage) | letzte 14 Tage aggTrades + Klines (≈ 0,8 GB) |
| Postgres + Timescale | Docker, gleiche gepinnte Version wie VPS; vollständige DB | Docker; vollständige DB (aus Transfer + tägliche Finalisierung) |
| Prozesse | importer (Backfill, Neuberechnung, täglicher Nachzug wenn eingeschaltet), verifier, Entwicklung | recorder, api, importer (täglich), health-ping, nginx |

Backup: Archiv auf dem Mac zusätzlich auf eine externe Platte oder einen Cloud-Speicher spiegeln; monatlicher SHA256-Abgleich gegen das Manifest (Skript). Jede Datei ist zudem bei Binance erneut ladbar, solange Binance sie anbietet.

**Was der VPS ohne den Mac kann:** Charts ausliefern; live aufzeichnen; jeden Tag selbst finalisieren (lädt die Tagesdatei und die Klines selbst, ersetzt, gleicht ab); den leichten Verifier über das 14-Tage-Fenster laufen lassen; alarmieren.

**Was den Mac (oder einen Neu-Download von Binance) braucht:** Neuberechnung der Historie nach einer Regeländerung (z. B. Order-Merge-Regel, Big-Trade-Untergrenze, neue Rollup-Stufe, neue Tabelle); Historie eines neuen Symbols; Tiefenprüfung alter Tage; Wiederaufbau nach DB-Verlust (Mac überträgt erneut).

**Täglicher Gleichlauf:** Ist der Mac eingeschaltet, lädt er dieselben Tagesdateien (für das Archiv) und importiert sie mit derselben Importer-Version. Beide Seiten berechnen je (Symbol, Tag) einen Digest (§4.8); der Mac holt die VPS-Digests per SSH und meldet Unterschiede. Das ist eine zusätzliche Reproduzierbarkeitsprüfung (K8).

**Transferverfahren (Erstübertragung):**
1. Mac: Backfill im Backfill-Modus (§4.1), alle Chunks außerhalb der letzten 3 Tage sind danach komprimiert.
2. Mac: `pg_dump -Fd -j 4` (Verzeichnisformat, parallel) der Anwendungsdatenbank. Komprimierte Chunks liegen in Timescales internen komprimierten Tabellen und werden in dieser Form gesichert, d. h. der Dump enthält die Basistabelle nicht entpackt (an einer Test-DB vor dem ersten echten Transfer bestätigen). Erwartete Größe ≈ DB-Größe (6–10 GB).
3. `rsync` auf den VPS, SHA256 je Dump-Datei vergleichen.
4. VPS: leere DB mit **identischer** Postgres- und Timescale-Version, `SELECT timescaledb_pre_restore();` → `pg_restore -j 2` → `SELECT timescaledb_post_restore();`. Spitzenbedarf Platte ≈ Dump + DB ≈ 20 GB (von 80 GB frei); Dump danach löschen.
5. Prüfung: Digest je (Tabelle, Symbol, Tag) auf beiden Seiten identisch; `data_day` identisch. Erst dann wird der VPS-Recorder für die Tage nach dem Transferstand freigeschaltet.

**Transferverfahren (Teilübertragung nach Neuberechnung):** Der Mac exportiert nur die betroffenen Tabellen und Tage als `COPY … TO STDOUT (FORMAT binary)` je (Tabelle, Symbol, Tag) mit Digest. Der VPS spielt sie chunkweise ein: Chunk dekomprimieren → Tage per Delete + COPY ersetzen → `compress_chunk` → nächster Chunk. Es ist also höchstens ein Chunk zur Zeit unkomprimiert (bei `fp_1m` ≈ 1 Tag ≈ 65 MB); **die VPS-Platte hält nie die unkomprimierte Basistabelle.** Danach Digest-Vergleich wie oben.

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
| Sprache Backend + Frontend | **TypeScript** (Node.js 24 LTS) | ein Typsystem für API-Encoding und Frontend-Decoding; lightweight-charts ist JS; PulseBot-Module (Parser, Seitenzuordnung, Value Area) sind übertragbar |
| DB-Treiber | `postgres` (porsager) oder `pg` + `pg-copy-streams` | `COPY` für Massenimport |
| HTTP/WS | Fastify + `ws` | schnell, Schema-Validierung |
| Frontend | Svelte 5 + Vite, lightweight-charts 5.x (gepinnt) | Svelte bekannt; Chartdaten außerhalb der Reaktivität (§7.3) |
| Tests | Vitest + fast-check, Playwright | |
| Verifier | **Python 3.12 + DuckDB + pyarrow** | andere Sprache und Engine. DuckDB liest ZIP nicht direkt: `zipfile` → pyarrow-CSV → DuckDB |
| DB | PostgreSQL 17 + TimescaleDB Community, columnstore-API (`enable_columnstore`, `add_columnstore_policy`; die alte Kompressions-API ist deprecated) | Entscheidung gesetzt |

Erwogen und verworfen: **Python/FastAPI als Backend** (zwei Sprachen zwischen Binärformat und Frontend; Aggregation liegt ohnehin in SQL/Importer); **Rust/Go** für Importer/Recorder (neue Sprache, Durchsatzbedarf ≈ 2 Mio. aggTrades/Tag/Symbol ist für Node unkritisch); **React/Solid** (kein Vorteil für Canvas-Rendering); **Continuous Aggregates** (§3.5); **ClickHouse/QuestDB** (Postgres/Timescale ist gesetzt, zusätzlicher Betrieb).

---

## 3. Datenmodell

### 3.1 Rohdateien (Quelle der Wahrheit)

**Quelle der Wahrheit sind die aggTrades-Dateien von Binance Vision** (vollständig auf allen geprüften Tagen, gleiche Form wie der Live-Stream).

- **Erstimport der Historie:** Für abgeschlossene Monate (2025-01 … 2026-10) werden die bereits geladenen und gegen ihre `.CHECKSUM` geprüften **Monatsdateien** verwendet (≈ 12–14 GB). Sie gleichwertig zu nutzen spart einen erneuten Download von ≈ 1 300 Tagesdateien mit denselben Daten. Der Importer zerlegt eine Monatsdatei beim Streamen nach UTC-Tag (`floor(T / 86 400 000)`). Ab da wird jeder Tag **genau wie eine Tagesdatei** behandelt: gleiche Manifest-Einträge je Tag, gleiche Digests, gleiche Klassifikation, gleiche Tagesrand-Behandlung, auch über Monatsgrenzen (Übertrag s(−1) und `continues_prev` vom letzten Tag des Vormonats).
- **Laufender Betrieb, VPS-Fenster, Monate ohne Monatsdatei:** ausschließlich Tagesdateien.
- Es gibt keine Überlappungsprüfung zwischen Monats- und Tagesdateien im Betrieb. Jeder Tag hat genau eine Quelle, die in seinem Manifest steht. Die Gleichwertigkeit wird einmalig in P1 nachgewiesen (§8).

```
data/raw/binance-vision/futures/um/monthly/aggTrades/{SYM}/{SYM}-aggTrades-{YYYY-MM}.zip(.CHECKSUM|.manifest.json)   # nur Erstimport
data/raw/binance-vision/futures/um/daily/aggTrades/{SYM}/{SYM}-aggTrades-{YYYY-MM-DD}.zip(.CHECKSUM|.manifest.json)
data/raw/binance-vision/futures/um/daily/klines/{SYM}/1m/{SYM}-1m-{YYYY-MM-DD}.zip(.CHECKSUM|.manifest.json)
data/raw/binance-vision/futures/um/daily/trades/{SYM}/{SYM}-trades-{YYYY-MM-DD}.zip(.CHECKSUM)   # nur Stichprobentage (§4.7)
data/live/{SYM}/{YYYY-MM-DD}/{HH}.csv.zst                                                    # Live-Spool (nur VPS)
```

Klines kommen aus den Vision-Dumps (Checksum, reproduzierbar, kein API-Gewicht), nicht per REST.

Das Manifest besteht aus einem JSON-Sidecar je Datei und den Tabellen `raw_file` (eine Zeile je Datei) und `raw_day` (eine Zeile je Symbol-Tag). Beide Tabellen lassen sich aus den Sidecars rekonstruieren; das Sidecar einer Monatsdatei enthält die Tageseinträge als Liste. Die Felder je Tag sind für beide Herkunftsarten identisch:

| Feld | Inhalt |
|---|---|
| `symbol`, `kind` (aggTrades/klines/trades), `day` | Identität des Tages |
| `origin` (`daily`/`monthly`), `origin_path`, `origin_sha256` | Herkunft: Pfad und geprüfte SHA256 der Tages- bzw. Monatsdatei (bei `monthly` für alle Tage des Monats dieselbe Datei) |
| `bytes`, `sha256`, `checksum_expected`, `checksum_ok` | Integrität der Datei (in `raw_file`) |
| `rows`, `first_agg_id`, `last_agg_id`, `agg_id_holes`, `agg_id_dups`, `ts_backwards` | Vollständigkeit je Tag (bei `monthly` beim Zerlegen abgeleitet); erwartet je 0. Für Monatsdateien zusätzlich: Σ Tageszeilen = Zeilen der Datei, Tage lückenlos 1…n, ID-Bereiche aufeinanderfolgender Tage lückenlos |
| `continues_prev` | `first_agg_id = last_agg_id(Vortag) + 1` |
| `first_ts`, `last_ts` | müssen im UTC-Tag liegen |
| `header_present`, `downloaded_at`, `importer_version` | Herkunft |

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
  big_floor_n    bigint,                         -- Untergrenze big_order als ganzzahliges Notional (§3.7), NULL bis P5
  data_from      date NOT NULL,                  -- 2025-01-01
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

Begründung: aggTrades sind die einzige vollständige Quelle; die Zeiten der einzelnen Fills sind darin nicht enthalten. Folge (gemessen, §4.5): 68–197 aggTrades pro Symbol-Tag haben Fills in der Folgeminute; dadurch weicht unser Minutenvolumen in 12–32 % der Minuten geringfügig von der Binance-Kline ab (Volumen P50 ≈ 0,013 BTC, Maximum 15 BTC in einer Minute). Footprint-Summen und Bar-Volumen sind untereinander konsistent (beide nach dieser Regel); die Kline-Trade-Anzahl wird als Referenzwert separat angezeigt.

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

Gezählt werden aggTrades, nicht Einzeltrades: `l − f + 1` ist nachweislich keine verlässliche Trade-Anzahl (ID-Löcher ohne Menge innerhalb von aggTrade-Bereichen, §4.5). `integer` reicht für Mengen pro Minute und Preis (Importer prüft Überlauf); Rollups verwenden `bigint`. **Delta = buy_q − sell_q.**

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
| `fp_1m` | 1m | Preis (1 Tick) | 0,1 $ | 0,01 $ | 650 k / 290 k (gemessen) |
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
  agg_n smallint NOT NULL,
  PRIMARY KEY (sym_id, ts, first_agg_id)
);
```

**Untergrenze `big_floor_n` (zwei Durchläufe):** Unterstützt werden nur Schwellen ab dem oberen 1 % der Orders (entschieden: Perzentile ≥ P99). Durchlauf 1 berechnet `size_hist_*` für die gesamte Historie (braucht keine Untergrenze). Daraus: `big_floor_n` = 0,5 × Minimum des stündlichen `rolling7d`-P99 (beide Seiten) über die gesamte Historie, auf eine Bucketgrenze abgerundet. Durchlauf 2 schreibt `big_order` mit `notional ≥ big_floor_n`. Damit liegt jede zulässige Schwelle (≥ P99 in jedem 7-Tage-Fenster und – wegen Faktor 0,5 – mit Reserve auch in `how`/`daysofar`-Fenstern) über der Untergrenze. Der resultierende Anteil gespeicherter Orders wird gemessen und hier nachgetragen (Erwartung: einige Prozent). Fällt eine Schwelle dennoch unter die Untergrenze, markiert die API das Intervall `incomplete`.

### 3.8 Qualität, Referenzdaten, Betrieb

```sql
CREATE TABLE data_day (
  sym_id smallint, day date, PRIMARY KEY (sym_id, day),
  state text NOT NULL,       -- Zustandsautomat §4.3
  version integer NOT NULL DEFAULT 0,   -- +1 bei jedem Ersatz; Basis für Cache-Versionen (§5.4)
  source text,               -- 'live' | 'live+rest' | 'vision'
  raw_sha256 text, rows bigint, first_agg_id bigint, last_agg_id bigint,
  min_exact int, min_shift int, min_mismatch int, min_missing int, min_gap int, edge_pending boolean,
  deep_check text,           -- NULL | 'passed' | 'failed' | 'reference_unusable'
  digest text,               -- §4.8
  importer_version text, imported_at timestamptz, verified_at timestamptz
);
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
```

`kline_1m` ist Referenz- und Anzeigedatum: die **Trade-Anzahl pro Minute kommt aus den Klines** (Stats-Zeile „Trades", auf jedem Zeitrahmen exakt als Summe).

Backup auf dem VPS: täglicher `pg_dump` nur der kleinen Tabellen (`data_day`, `data_minute_issue`, `verify_run`, `raw_file`, `symbol*`) und der Konfiguration; der Mac holt ihn ab. Alles andere ist aus dem Archiv rekonstruierbar.

### 3.9 Kompression und Aufbewahrung

| Tabelle | Chunk | columnstore nach | Retention |
|---|---|---|---|
| `fp_1m` | 1 Tag | 3 Tagen | keine |
| `fp_1m_b10`, `fp_5m_b10`, `size_hist_1m` | 7 Tage | 3 Tagen | keine |
| `fp_15m_b100`, `fp_1h_*`, `bar_1m`, `kline_1m`, `big_order` | 30 Tage | 3 Tagen | keine |
| `fp_1d_*`, `bar_1h/1d`, `size_hist_1h` | 1 Jahr | 7 Tagen | keine |
| Live-Spool (VPS) | – | zstd | 7 Tage nach `final_ok` |
| Tagesdateien (VPS) | – | – | 14 Tage |

Die Policies greifen nur im laufenden Betrieb. Backfill und Neuberechnung komprimieren explizit (§4.1); ein Re-Import eines alten Tages dekomprimiert den betroffenen Chunk, ersetzt und komprimiert neu.

### 3.10 Größenschätzung (BTC + ETH, 2025-01-01 bis heute ≈ 692 Tage)

Schätzungen auf Basis der gemessenen Zeilenzahlen und angenommener 6–10 B/Zeile komprimiert (nicht gemessen; wird in P1 gemessen und nachgetragen).

| Posten | Bestand heute | Zuwachs/Jahr |
|---|---|---|
| `fp_1m` (≈ 650 Mio. Zeilen) | 3,9–6,5 GB | 2,1–3,4 GB |
| `fp_1m_b10` + `fp_5m_b10` | 0,6–1,0 GB | 0,3–0,5 GB |
| übrige Rollups, `bar_*`, `kline_1m` | < 0,3 GB | < 0,15 GB |
| `size_hist_1m` (Arrays komprimieren schwach) | 0,4–1 GB | 0,2–0,5 GB |
| `big_order` (Anteil nach §3.7 offen) | 0,2–1 GB | 0,1–0,5 GB |
| Indizes, unkomprimierte letzte Tage, WAL | ≈ 1–2 GB | |
| **Postgres gesamt** | **≈ 6–12 GB** | **≈ 3–5 GB** |
| Rohdaten aggTrades BTC (23–35 MB/Tag gemessen) – nur Mac | 16–24 GB | 8–13 GB |
| Rohdaten aggTrades ETH (angenommen ≈ 0,75 × BTC) – nur Mac | 12–18 GB | 6–10 GB |
| Klines 1m (klein) – nur Mac | < 0,1 GB | |
| trades-Dumps (BTC ≈ 61 MB/Tag gemessen), nur Stichprobe ≈ 30 Tage/Jahr/Symbol | ≈ 3–4 GB | ≈ 3 GB |

VPS-Platte: DB 6–12 GB + 14-Tage-Fenster < 1 GB + Spool + Transfer-Spitze ≈ 20 GB → ausreichend für mehrere Jahre.

---

## 4. Ingestion und Korrektheit

### 4.1 Historischer Import und Neuberechnung (Mac, Backfill-Modus)

1. Freien Platz prüfen; < 15 GB → Abbruch.
2. Columnstore-Policies pausieren (`alter_job(… scheduled => false)`).
3. Tage **in Zeitreihenfolge chunkweise**: je Tag die aggTrades bereitstellen (Tagesdatei, oder für abgeschlossene Monate des Erstimports den Tagesanteil der einmal geprüften Monatsdatei, §3.1) und die Kline-Tagesdatei laden, SHA256 prüfen (Abweichung → erneut laden; nach 3 Versuchen Abbruch mit Fehler, nie stiller Erfolg), Streaming-Parse mit Manifest, Aggregation im Speicher (BTC ≈ 1,8 Mio. aggTrades/Tag, < 500 MB), Transaktion wie §4.3, Abgleich §4.6.
4. Nach dem letzten Tag eines Chunks: `compress_chunk` für alle Tabellen dieses Zeitraums (bzw. columnstore-Konvertierung), bevor der nächste Chunk beginnt – keine Inserts in bereits komprimierte Chunks, kein unkomprimierter Rückstau.
5. Am Ende Policies wieder aktivieren, Digests berechnen, Verifier starten.

Dauer wird gemessen und in P1 dokumentiert (Abnahmekriterium).

### 4.2 Live-Pfad (Recorder, VPS)

- Je Symbol eine WS-Verbindung `wss://fstream.binance.com/market/ws/<symbol>@aggTrade` (aggTrade liegt seit der Routing-Umstellung 2026 unter `/market`; vom Review gegen die offizielle Change Notice bestätigt). Geplanter Wechsel nach 23 h mit **Überlappung** (neue Verbindung zuerst, Deduplizierung per aggId).
- **Lückenerkennung per aggId.** Gemessen sind aggIds innerhalb und über Tagesgrenzen strikt fortlaufend (0 Löcher, 0 Duplikate). Regel: erwartet `a = last_a + 1`; bei `a > last_a + 1` wird per REST `GET /fapi/v1/aggTrades?fromId=last_a+1&limit=1000` nachgeholt (Seiten über `fromId`, nie über `startTime`). Liefert REST als erste ID einen Wert > `last_a + 1`, ist bewiesen, dass die fehlenden IDs nicht existieren (wird protokolliert). `a ≤ last_a` → Duplikat, verwerfen.
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
| `final_ok` | offizielle Datei, 0 `mismatch`/`missing` | niemand | → `importing` (Neuberechnung) |
| `final_bad` | offizielle Datei, ≥ 1 `mismatch`/`missing` | niemand | → `importing` (Neuberechnung); Ops-Alarm über Health |

Regeln:
- **Ersatz nur nach erfolgreicher Checksumme und vollständigem Parse.** Erst dann beginnt die Transaktion: `DELETE` aller Zeilen des Tages in allen Tabellen → `COPY` → `data_day` (`version + 1`) → Commit. Ein `final_bad` aus einer korrekt geprüften Datei bleibt die Wahrheit (die Datei ist die Quelle; die Abweichung wird gezeigt und untersucht).
- Der Recorder prüft vor jedem Minuten-Commit in derselben Transaktion `state = 'provisional'` (`SELECT … FOR SHARE`); die DB-Rolle `of_recorder` erzwingt das zusätzlich per Funktion.
- Replace statt Merge: es gibt kein `UPDATE … SET vol = …` auf Level-Ebene.
- Idempotenz: Re-Import erzeugt identischen Digest.
- Timer 07:45 UTC (Datei erscheint beobachtet gegen 07:21 UTC), Wiederholung alle 30 min. Protokolliert wird, wie viele provisorische Minuten exakt mit der offiziellen Datei übereinstimmten (Recorder-Qualitätskennzahl, Ziel ≥ 99,9 %).

### 4.4 Exakte Regeln für Preis, Menge, Seite

**Zeit:** T muss 13-stellig (ms) sein, sonst Abbruch (Schutz gegen µs-Formate wie im Spot-Archiv). Minute nach §3.3.

**Preis/Menge:** nie als Float. Dezimalstring an `.` trennen, Nachkommateil auf `price_decimals` mit Nullen auffüllen (mehr Stellen nur zulässig, wenn die überzähligen `0` sind, sonst Fehler), Ganzzahl bilden; das ist `px`. Gleiches Verfahren für Mengen → Lots. Damit sind „Grenzpreis eine Zeile zu tief" und „Float-Müll als Schlüssel" ausgeschlossen. Zeilenbildung nur per Integer-Division.

**Seite:** `m = true` → Verkäufer ist Aggressor → `sell_q` („Bid"); `m = false` → `buy_q` („Ask").

### 4.5 Ergebnis des Datenexperiments (ersetzt die Hypothese aus Fassung 1)

5 Symbol-Tage (BTCUSDT 2026-11-20/21/22, ETHUSDT 2026-11-21/22), exakte Dezimalrechnung, aggTrades vs. trades-Dump vs. 1m-Klines:

| Befund | Ergebnis |
|---|---|
| Klines entstehen aus den Zeiten der Einzelfills | auf 4/4 vollständigen Tagen stimmen Volumen, Taker-Buy und Trade-Anzahl aller 1 440 Minuten exakt, wenn man Einzeltrades nach eigener Zeit summiert |
| `T` eines aggTrades | = Zeit seines **ersten** Fills (100 %); Fill-Spanne ≤ 100 ms inkl.; gleicher Preis und gleiche Seite; Fill-Zeiten monoton in der ID |
| Straddler (Fills in der Folgeminute) | 68–197 je Symbol-Tag; immer genau zwei benachbarte Minuten; T immer in der früheren Minute, 1–95 ms vor der Grenze; immer Mehrfach-Fill |
| Abweichung bei Zuordnung nach T | alle drei Größen exakt nur in 981–1 265 von 1 440 Minuten; meist winzig (Volumen P50 ≈ 0,013 BTC, max. 15 BTC) |
| nach Verschieben der Straddler-Fills | Volumen und Taker-Buy 1 440/1 440 exakt; Rest nur Tagesrand (letzter aggTrade des Tages mit Fill nach Mitternacht, gespiegelt in Minute 0), mit Nachbartag auflösbar |
| Trade-Anzahl aus `l − f + 1` | **nicht** exakt ableitbar: 64–742 „Loch-IDs" je Tag innerhalb von aggTrade-Bereichen (ohne Menge, in Klines nicht gezählt), 353–1 523 IDs je Tag zwischen aggTrades fehlend; in 35–76 Minuten/Tag übersteigt der ID-Span-Count jede Straddler-Erklärung (bis +402). Was diese IDs sind, ist unbekannt (Insurance-Fund/ADL ist eine Vermutung) |
| aggId-Kontinuität | strikt fortlaufend innerhalb und über Tagesgrenzen, keine rückwärtslaufenden Zeiten |
| trades-Dump-Qualität | BTCUSDT 2026-11-20 ist in den Stunden 19–23 UTC lückenhaft (16 885 fehlende Trade-IDs; 6 019 aggTrades ohne einen ihrer Fills), während Klines und aggTrades das Volumen enthalten. Der trades-Dump ist **nicht** unbedingt zuverlässig; aggTrades waren an allen Tagen vollständig |

Konsequenzen: (1) Produktregel §3.3; (2) Abgleich nur über Volumen und Taker-Buy mit der engen Hülle §4.6; (3) Trade-Anzahl nur als Referenz aus Klines, nicht als Prüfgröße; (4) Tiefenprüfung §4.7 beweist die Kline-Gleichheit dort, wo der trades-Dump nachweislich vollständig ist; (5) keine Klasse `source_excluded` – Volumen und Taker-Buy gehen vollständig auf, die Loch-IDs tragen keine Menge.

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
| `edge_pending` | Minute 0 oder 1 439, solange der Nachbartag nicht abgeglichen ist |

Tagessumme: `Σ unser − Σ kline = s(1 439) − s(−1)`, mit beiden Überträgen innerhalb ihrer Kandidatengrenzen – das ist die „exakte Tagessumme bis auf Tagesrand-Straddler". OHLC wird als Bericht verglichen (Abweichungen nur durch Kandidatenpreise zulässig), nicht als Klasse.

Grenzen der Prüfung: Sie ist eine notwendige Bedingung und locker (907–2 273 Kandidaten/Tag gegenüber 68–197 echten Straddlern). Ein Fehler, der Menge aus den letzten 100 ms einer Minute in die Folgeminute verschiebt, könnte maskiert werden – nicht aber ein Off-by-one, der einen aggTrade mit T = k·60 000 in die Vorminute legt (der erzeugt D(m−1) > 0 ohne passenden Übertrag, sobald kein Kandidat ihn zufällig deckt; zusätzlich deckt ihn Test T3 ab). Den vollständigen Beweis liefert die Tiefenprüfung.

Folgen: `final_ok` bei 0 `mismatch`/`missing`, sonst `final_bad` + Ops-Alarm; bei Live-Daten löst `mismatch` beim Minutenabschluss keinen Alarm aus (Klines des Tages liegen erst am Folgetag vor), sondern erst die Finalisierung bewertet.

### 4.7 Tiefenprüfung gegen den trades-Dump

Stichprobe (deterministisch, Seed im Repo): die ersten 7 Tage der Historie je Symbol; 2 zufällige Tage je Monat und Symbol; jeder Tag mit `mismatch`; zusätzlich auf Anforderung (`verifier deep --day …`). Läuft auf dem Mac.

1. trades-Dump des Tages laden (+ CHECKSUM).
2. **Vollständigkeit der Referenz prüfen:** für jeden aggTrade müssen die Einzeltrades mit ID in [f, l], die im Dump vorhanden sind, in Summe genau seine Menge ergeben, mit gleichem Preis und gleicher Seite (Loch-IDs ohne Menge sind zulässig); zusätzlich Σ Menge je Stunde = Σ Kline-Volumen je Stunde. Jede Stunde, in der das nicht gilt, ist **„Referenz unbrauchbar"**.
3. In den brauchbaren Stunden: Einzeltrades nach eigener Zeit je Minute summieren → muss mit Kline-Volumen, Taker-Buy und Trade-Anzahl **exakt** übereinstimmen (beweist das Kline-Modell).
4. Für jeden Straddler die verschobene Menge s(m) exakt aus den Fill-Zeiten bestimmen und prüfen: `D(m) = s(m) − s(m−1)` exakt für alle Minuten (beweist, dass unsere Minuten exakt der Produktregel entsprechen) und Klasse `shift` aus §4.6 für genau diese Minuten zutreffend.
5. Level-Summen je (T-Minute des Eltern-aggTrades, Preis, Seite) aus dem trades-Dump = `fp_1m` (unabhängige Quelle für die Level-Ebene).

Ergebnis in `data_day.deep_check`: `passed`, `failed` (echter Fehler → Ops-Alarm) oder `reference_unusable` (lückenhafter Dump; **nie** als Datenfehler gewertet; bei Teilbrauchbarkeit gilt `passed` nur für die brauchbaren Stunden, im Bericht ausgewiesen).

### 4.8 Unabhängige Neuberechnung (Verifier) und Digests

Der Verifier (Python, DuckDB) liest die ZIP-Dateien (`zipfile` → pyarrow-CSV → DuckDB) und berechnet unabhängig:
- Minutensummen und Level-Summen je (Minute, px) – alle Tage nach Backfill;
- **alle Rollup-Tabellen** und die `bar_1m`-Komposita (Max/Min-Delta, COT) – alle Tage nach Backfill, danach wöchentlich 20 zufällige Tage;
- eine Stichprobe der API-Antworten: ≈ 50 Requests, Binärformat in Python dekodiert, gegen die eigene Rechnung;
- ab P5: Order-Merge, Histogramm-Buckets (ganzzahlig, daher bitgleich), `big_order`.

Jede Abweichung ist ein Fehler (keine Toleranz – beide Seiten rechnen ganzzahlig auf denselben Rohdaten). Einschränkung: Verifier und Importer setzen dieselbe Spezifikation um, vermutlich vom selben Agenten geschrieben; Interpretationsfehler (Seite, Minutenregel) würden sich wiederholen. Diese Lücke schließen die externen Prüfungen: Kline-Abgleich (§4.6) und Tiefenprüfung gegen den trades-Dump (§4.7), die eine andere Binance-Quelle nutzt.

**Digest:** je (Tabelle, Symbol, Tag) SHA256 über die nach Primärschlüssel sortierten Zeilen in kanonischer Textform (SQL-Funktion `day_digest`). Verwendet für Idempotenz (K8), Transferprüfung (§2.3) und den Mac/VPS-Gleichlauf.

### 4.9 Qualitätsanzeige

`GET /api/v1/quality?sym&from&to` liefert je Tag Zustand, Quelle, Zähler, Tiefenprüfung und Issue-Minuten. Die UI zeigt ein farbiges Band unter der Zeitachse (grün `final_ok`; gelb `provisional`, `provisional_import_failed`, `edge_pending`; rot `gap`, `final_bad`), Tooltip mit Zählern, Markierung betroffener Bars; `shift`-Minuten gelten als korrekt und werden nur im Tooltip gezählt. Statusbutton: Recorder-Zustand, Datenalter, Health.

### 4.10 Teststrategie

| Test | Art | Inhalt |
|---|---|---|
| T1 Parser | Property | zufällige Dezimalstrings → px/Lots exakt; Off-Grid → Fehler; Rundtrip |
| T2 Zeilenbildung | Property | jeder px in genau einer Zeile; Rebinning aus jedem Bin = direkte Bildung für alle R der Leiter |
| T3 Minutenzuordnung | Unit | T = k·60 000 − 1, k·60 000, k·60 000 + 1, Tagesgrenze; permutierte Eingabe → gleiches Ergebnis |
| T4 Rollup-Äquivalenz | Property | Σ(1m) = 5m = 15m = 1h = 1d; Max/Min-Delta- und COT-Komposition = Brute-Force über aggTrades |
| T5 Klassifikator | Property | synthetische Tage mit eingebauten Straddlern → genau diese Minuten `shift`, Rest `exact`; eingebauter Off-by-one (T = k·60 000 → Vorminute) ohne deckenden Kandidaten → `mismatch`; Tagesrand-Fälle |
| T6 Value Area | Property | enthält POC, zusammenhängend, ≥ va_pct, deterministisch bei Gleichstand |
| T7 Golden Files | Integration | Mini-CSV (≈ 30 handgerechnete Trades inkl. Grenzfälle) im Repo; dazu die 5 Experiment-Tage (ZIPs per Skript geladen, per SHA256 gepinnt), erwartete Minutensummen und Klassifikation als CSV im Repo |
| T8 Idempotenz | Integration | Tag zweimal importieren → identischer Digest |
| T9 Live-Chaos | Integration | WS-Trennung mitten in der Minute, künstliche ID-Lücken, Recorder-Kill inkl. abgeschnittenem zstd-Frame, DB-Ausfall → lückenlos; Vergleich mit offizieller Datei am Folgetag |
| T10 API | Integration | Endpunkte gegen naive Referenzrechnung; zusätzlich Verifier-Stichprobe (§4.8) |
| T11 Render-Performance | Playwright | 25 000 sichtbare Zellen, Frame-Zeit und Long Tasks gegen §1.4 |
| T12 Order-Merge (P5) | Property | Partition der aggTrades; Σ Menge/Notional erhalten |

CI startet eine Timescale-Instanz im Container für T7–T10.

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

Kachel = n Bars des Zeitrahmens, ausgerichtet an Vielfachen von n·tf seit Epoch. **n hängt von (Symbol, tf, R) ab**, damit die erwartete Zellzahl ≤ 30 000 bleibt: `n = clamp(2^floor(log2(30 000 / Zeilen_pro_Bar)), 32, 1024)`, mit `Zeilen_pro_Bar` = Median-Range der Bars dieses tf über die letzten 30 Tage / R, monatlich neu berechnet und als Konfigurationsversion Teil des Kachelschlüssels. Beispiel BTC 1m bei R = 1 Tick (≈ 450 Zeilen/Bar) → n = 64.

### 5.4 Versionen, Caching, Padding, Abbruch

- **Datenversion:** `data_day.version`. Kachelversion = Hash der Versionen aller überdeckten (Symbol, Tag) + Konfigurationsversion. ETag = Kachelversion.
- Kacheln, die nur `final_*`-Tage überdecken, sind unveränderlich (`Cache-Control: immutable`) und liegen im Server-LRU (≤ 200 MB, vorkomprimiert). Kacheln mit `provisional`-Tagen werden **nie** gecacht; der Client patcht sie per WS.
- Wechselt ein Tag nach `final_*`, pusht die API über den Live-WS ein Invalidierungsereignis (Symbol, Tag, neue Version); der Client lädt betroffene sichtbare Kacheln neu.
- Client: Kachel-Cache, LRU nach Zellzahl (≤ 2 Mio.); sichtbare Kacheln + 1 Kachel Padding je Seite, Prefetch in Panrichtung; höchstens 4 parallele Requests.
- Jeder Request hat einen `AbortController`; verlässt eine Kachel den Bedarf, wird abgebrochen; die API bricht die Query bei Client-Abbruch ab.

### 5.5 Endpunkte

| Endpunkt | Parameter | Liefert |
|---|---|---|
| `GET /api/v1/symbols` | – | Symbole, Einheiten, Tickhistorie, Datenbeginn |
| `GET /api/v1/bars` | sym, tf, from, to | OHLC + Stats-Felder je Bar (inkl. Kline-Trade-Anzahl), Qualitätsflag |
| `GET /api/v1/footprint` | sym, tf, R, tile | Bars + Level (row, buy, sell, buy_a, sell_a) |
| `GET /api/v1/profile` | sym, from, to, R | Level-Summen + POC/VAH/VAL/Delta-POC |
| `GET /api/v1/profiles/daily` | sym, from, to, R, day_offset_h, va_pct | je Tag Level + POC/VAH/VAL |
| `GET /api/v1/tpo` | sym, day, block_min, R, ib_min | §6.5 |
| `GET /api/v1/bigtrades` | sym, from, to, def, Parameter, tiers, side_mode | Orders ≥ Schwelle mit Stufe; Schwellen-Stufenreihe; `incomplete`-Intervalle |
| `GET /api/v1/thresholds` | sym, from, to, def, … | nur Schwellen-Zeitreihe |
| `GET /api/v1/quality` | sym, from, to | §4.9 |
| `GET /api/v1/health` | – | §2.5; nur von localhost erreichbar (nginx leitet ihn nicht nach außen) |
| `WS /api/v1/live` | subscribe {sym, tf, R, features} | formender Bar (Diffs), committed Bars aus DB, Big Trades, Invalidierungen |

Zeitparameter in ms UTC, `[from, to)`. Die API hat **ausschließlich lesende Endpunkte**; Import, Neuberechnung, Transfer und jede Wartungsaktion laufen nur per CLI/systemd auf dem Server und sind über HTTP nicht erreichbar.

### 5.6 Binärformat

Länge-präfixierter JSON-Header (Formatversion, Symbol, tf, R, Spalten, Kachelversion, Qualitätsflags), danach spaltenweise Typed Arrays, Little Endian, 8-Byte-ausgerichtet:
- Bars: `time` Int32 (s), `open/high/low/close` Int32 (px), Volumina Float64 (Lots; Ganzzahlen < 2⁵³ exakt), Zähler Int32, `levelOffset` Int32.
- Level: `row` Int32, `buy`, `sell` Float64, `buyA`, `sellA` Int32.
Kompression gzip (nginx) bzw. vorkomprimiert aus dem Server-Cache. ≈ 28 B/Zelle roh → 30 000 Zellen ≈ 840 kB roh; komprimierte Größe in P1 messen.

### 5.7 Live-Updates

- Eine WS-Verbindung je Tab; Abo nur für das angezeigte Symbol/tf/R (Wechsel ersetzt das Abo).
- Formender Bar in der API: committed Minuten des laufenden tf-Bars aus der DB + formende Minute aus dem Feed; Level als Map `row → {b,s,ba,sa}` (O(1) pro Trade). Diff höchstens alle 250 ms.
- Nach „Minute M committed" (§4.2) sendet die API M aus der DB.

---

## 6. Feature-Spezifikationen

Referenzen: **DC** = DeepCharts (öffentliche Doku, Formeln teils unbekannt), **TV** = TradingView. TV rechnet seinen Footprint standardmäßig aus Intrabars und leitet die Seite aus deren Richtung ab; unser Footprint nutzt das Aggressor-Flag und darf daher vom TV-Standard abweichen.

### 6.1 Footprint

| Element | Definition | Default | Referenz | Stufe |
|---|---|---|---|---|
| Zeile | `floor(px / (R·tick_ref_units))`, R aus Leiter {1,2,5}·10^k Ticks, R ≥ aktueller Tick | auto | TV/DC | v1 |
| Auto-R | R so, dass der Median-Range der letzten 200 abgeschlossenen Bars des tf ≈ 24 Zeilen hat; neu nur bei Symbol-/tf-Wechsel, LOD-Anpassung am Gestenende (§7.2) oder per Knopf, **nie beim Pannen** | 24 Zeilen | eigen (TV: 0,2 × ATR, unbestätigt) | v1 |
| R manuell | Ticks pro Zeile aus der Leiter | – | TV/DC | v1 |
| Gitter an Bar-Open verankert | – | aus | DC | später (nur aus `fp_1m`) |
| Typ Bid×Ask | links sell, rechts buy | – | TV/DC | v1 |
| Typ **Delta** | eine Zahl je Zeile b − s; Farbe nach Vorzeichen, Intensität nach Betrag | **Default** | TV/DC | v1 |
| Typ Volume | b + s | – | TV/DC | v1 |
| Typ Delta + Volume | Delta links, Volumen rechts | – | DC | v1 |
| Modus Box / Profile | Zahl in gefärbter Zelle / horizontaler Balken je Zeile (Länge ∝ Wert / Max im Bar) | Box | DC/TV | v1 |
| Zelleingabe | Volumen oder **Anzahl aggTrades** (nicht DCs Trade-Anzahl; Einzeltrade-Zahlen pro Level sind aus aggTrades nicht exakt ableitbar) | Volumen | DC | v1 |
| Mehrere Spalten pro Bar (bis 4) | – | – | DC | später |
| Ladder, dynamische Schriftgröße, Cluster-Umrisse | – | – | TV/DC | später |
| Formender Bar | live | an | – | v1 |

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

### 6.3 Volume Profile

| Element | Definition | Default | Stufe |
|---|---|---|---|
| Custom Range | Zeitbereich per Ziehen (§7.5), `[t0, t1)` auf Minuten gerundet | – | v1 |
| Tagesprofile | je Tag, links am Tagesbeginn, Breite = Tagesbreite × 0,8 | an bei tf ≤ 1h | v1 |
| Tagesgrenze | UTC 00:00; Offset in ganzen Stunden (entschieden); 1d-Rollups nur bei Offset 0, sonst 1h-Rollups | 0 | v1 |
| Zeilen | eigenes R, **unabhängig vom Footprint-R** (POC/VA von Profil und Bars dürfen daher abweichen); auto ≈ 120 Zeilen (Range) bzw. ≈ 60 (Tag) | auto | v1 |
| Darstellung | Total; Buy/Sell gestapelt; Delta | Total | v1 |
| POC, VAH, VAL | §6.1, va_pct 70 % | an | v1 |
| Linien verlängern | bis Chartende oder nächstes Profil | aus | v1 |
| Naked POC, Wochen-/Monatsprofile | – | – | später |

### 6.4 Big Trades (Phase P5)

**Einheit:** Order nach §3.7; Position = (Bar-Zeit, VWAP der Order). Tooltip zeigt Notional, Menge, Preisspanne, Anzahl aggTrades, Perzentilrang; die Fill-Zahl wird mit „≈" gekennzeichnet (Order-Regel ist heuristisch).

**Schwellen** aus `size_hist_1h`, nach Anzahl Orders, log-linear interpoliert; Seiten gemeinsam (Default) oder getrennt; nur Perzentile p ≥ 99 wählbar:

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

`bs` = Bar-Abstand (px), `rh` = Zeilenhöhe (px), `vc` = geschätzte sichtbare Zellen = Σ über sichtbare Bars der Zeilen innerhalb des sichtbaren Preisbereichs.

| Stufe | Bedingung | Darstellung | Daten |
|---|---|---|---|
| L3 Zahlen | bs ≥ 44 (eine Zahl/Spalte) bzw. ≥ 80 (Bid×Ask, Delta+Volume), rh ≥ 11, vc ≤ 25 000 | Text (10 px) in Zellen | Level |
| L2 Zellen | bs ≥ 6, rh ≥ 2, vc ≤ 25 000 | gefärbte Zellen, POC-Rahmen | Level |
| L1 Kerzen | sonst | Kerzen + Profile/Big Trades | nur `bars` |

Auto-R: fällt rh unter 2 px oder überschreitet vc 25 000, wird R am Gestenende (Debounce 150 ms) um eine Leiterstufe vergrößert (wiederholt, bis die Bedingungen gelten); steigt rh über 40 px, verkleinert. Bei manuellem R fällt die Ansicht auf L1 zurück, mit Hinweis „Zeilengröße zu fein für diesen Ausschnitt". Während einer Geste ändert sich R nie; Hysterese 10 % gegen Flackern.

### 7.3 Zustand und Zeichnen (gegen die PulseBot-Probleme)

- Chartdaten in **nicht-reaktiven** Typed Arrays (`DataStore`-Modul); Svelte-`$state` nur für UI-Einstellungen (Symbol, tf, Typ, R-Modus, …), `$state.raw` wo nötig.
- Beim Laden einer Kachel einmalig berechnet und abgelegt: Farb-Referenz-Beiträge, Imbalances, Stacked-Zonen, POC/VA je Bar, **vorformatierte Text-Strings** der Zellen.
- `setData` nur bei Kachel-Ankunft bzw. tf-Wechsel; Live per `series.update()`. Obergrenzen: Footprint-Modus ≤ 5 000 Bars, Kerzen-Modus ≤ 20 000 Bars (setData mit 50 k Kerzen kann > 50 ms dauern); darüber erzwingt die UI einen größeren Zeitrahmen.
- Alle Overlays zeichnen in den Renderern der Bibliothek; kein separates, bei jeder Crosshair-Bewegung neu gezeichnetes Overlay-Canvas. Tooltips als DOM, per `requestAnimationFrame` gebündelt.
- Live-Diffs gepuffert, höchstens einmal pro Frame (max. 4/s).
- UI-Grundstruktur v1: Toolbar (Symbol, tf, Typ, R), Einstellungsdialog, Tooltips, Zustand in der URL (Symbol, tf, Ausschnitt, Profile).

### 7.4 TPO-Ansicht

Eigenes Canvas: x = Tage (Spalten fester Breite, ≤ 30 sichtbar), y = Preis (gemeinsame Skala, Zoom/Pan), je Tag Buchstabenmatrix, POC/VA/IB markiert, optional Volumenprofil rechts. LOD: Zellhöhe < 9 px → farbige Blöcke statt Buchstaben. Fertige Tage unveränderlich gecacht.

### 7.5 Custom-Range-Auswahl

Werkzeug „Profil": Ziehen im Chart markiert [t0, t1) (Snap auf Bar-Grenzen), nach Loslassen ein `profile`-Request; Profil als Primitive verankert, in der URL gespeichert, mehrere möglich, löschbar. Alternativ Eingabe per Datum/Uhrzeit (UTC). Während des Ziehens nur ein Rechteck, kein Request.

---

## 8. Ausbauphasen

Aufwand in Personentagen (PT), eine Person mit KI-Unterstützung. Reihenfolge (entschieden): **zuerst ein vertikaler Schnitt mit BTCUSDT**, der Datenkorrektheit und Performance – die beiden Top-Prioritäten – auf dem VPS beweist; danach der Rest. PulseBot läuft bis P2 weiter.

| Phase | Inhalt | Abnahmekriterien | PT |
|---|---|---|---|
| **P0 Grundgerüst** | Monorepo (`packages/core` Parser/Aggregation/Klassifikator, `apps/importer`, `apps/recorder`, `apps/api`, `apps/web`, `verifier/`), Docker-Postgres/Timescale (gepinnt), Migrationen, CI | `npm test` grün; Schema per Migration auf dem Mac reproduzierbar | 2–3 |
| **P1 Vertikaler Schnitt BTCUSDT** | (a) Importer im Backfill-Modus: aggTrades + Klines ab 2025-01-01, Manifest, `fp_1m`, alle Rollups aus §3.6, `bar_1m/1h/1d`, `kline_1m`, Zustandsautomat, Digests; (b) Klassifikator §4.6, Tiefenprüfung §4.7 auf den Stichprobentagen, Verifier §4.8 (ohne Order-Teil); (c) Transfer auf den VPS §2.3; (d) API `bars`, `footprint`, `quality` binär mit Guards, Kachellänge, Versionen; (e) Frontend: Kerzen + Footprint-Custom-Series mit L1/L2/L3, Zellbudget, Kachel-LRU, Typen Delta und Bid×Ask im Box-Modus, Qualitätsband, minimale Toolbar; (f) Benchmark auf dem VPS | Manifest: alle Checksums ok, aggIds über alle Tage strikt fortlaufend; **100 % der Minuten `exact` oder `shift`, 0 `mismatch`, 0 `missing`**, Tagessummen exakt bis auf Tagesrand-Straddler; Tiefenprüfung `passed` auf allen Stichprobentagen mit brauchbarer Referenz (`reference_unusable` dokumentiert, nicht als Fehler); Verifier 0 Abweichungen inkl. Rollups und API-Stichprobe; Re-Import digest-gleich; **Gleichwertigkeit Monats-/Tagesdatei:** 3 Tage (einer davon ein Monatserster, einer ein Monatsletzter) einmal aus der Monatsdatei und einmal aus der zusätzlich geladenen Tagesdatei importiert ergeben identische Digests in allen Tabellen und identische Tages-Manifesteinträge (bis auf `origin*`); Transfer digest-gleich, VPS-Platte nie mit unkomprimierter Basistabelle; Backfill-Dauer auf dem Mac gemessen; Benchmarks kalt **und** warm innerhalb §1.4 für: 1m-Footprint R = 1 Tick, 15m-Footprint über 3 Monate pannen, 4h-Footprint über 1 Jahr, 1h-Kerzen über 1 Jahr; T11 grün | 15–20 |
| **M1 – erstes sichtbares Ergebnis** | echter BTC-Footprint (Delta-Ansicht) auf dem VPS im Browser, geprüfte Daten, gemessene Budgets | nach **≈ 17–23 PT** | – |
| **P2 ETH + Live-Betrieb** | ETH-Backfill + Teilübertragung; Recorder (WS, Lücken, REST, Spool, Wiederanlauf, committed-Events), tägliche Finalisierung auf dem VPS, Live-Forming-Bar in API/Frontend, Health, health-ping + healthchecks.io, DB-Rollen, Backup der kleinen Tabellen, Mac/VPS-Gleichlauf; PulseBot + mongod stoppen | 72-h-Lauf mit erzwungenen Disconnects, Kill, abgeschnittenem Frame und DB-Neustart: keine unentdeckte Lücke; provisorische Tage ≥ 99,9 % Minuten identisch mit der offiziellen Datei; E-Mail-Alarm ≤ 15 min nach Einfrieren des Recorders und nach Abschalten des VPS-Netzes; Tagesersatz läuft 7 Tage unbeaufsichtigt; Restore-Probe (neue DB aus Archiv bis `final_ok`) mit gemessener Dauer | 8–11 |
| **P3 Volume Profile + UI-Grundstruktur** | `profile`, `profiles/daily`; Range-Werkzeug, Tagesprofile; Einstellungen, Symbolwechsel, Tooltips, URL-Zustand | Range-Profil 1 Jahr kalt/warm innerhalb §1.4; Profilsummen = Verifier | 6–8 |
| **P4 Footprint komplett + Stats-Grid** | alle Typen und Modi, Imbalances, Stacked, POC/Delta-POC/VA, Ratios, Farbmodi, Stats-Grid mit LOD | Budgets bei 25 000 sichtbaren Zellen; Footprint-Summen = `bars`; Komposita = Verifier; Sichtvergleich mit TV an 3 Stichproben dokumentiert | 9–12 |
| **P5 Big Trades** | Order-Merge (Importer + Recorder), `size_hist_*` (Durchlauf 1), Untergrenze, `big_order` (Durchlauf 2), Teilübertragung, `bigtrades`/`thresholds`, UI | Umschalten der Definition ≤ 300 ms ohne Rohdaten; Verifier bitgleich für Histogramme und `big_order`; gespeicherter Anteil gemessen und in §3.7 nachgetragen; `incomplete` am Datenbeginn getestet | 6–8 |
| **P6 TPO** | `tpo`, TPO-Ansicht | Property-Tests (VA, IB, Single Prints); 30 Tage flüssig | 4–6 |
| **Puffer** | Performance-Tuning nach Benchmarks, VPS-Härtung, Unvorhergesehenes (≈ 15 %) | – | 7–10 |
| **Summe** | | | **≈ 57–78** |

Die Schätzung liegt im Bereich des Reviews (55–75 PT). Fassung 1 (33–49 PT) enthielt weder Puffer noch UI-Grundstruktur noch Tiefenprüfung und Transfer.

---

## 9. Risiken

| Risiko | Auswirkung | Gegenmaßnahme |
|---|---|---|
| Footprint-Kacheln aus komprimierten Chunks langsamer als geplant (6–10 B/Zeile und Abfragezeiten nicht gemessen) | Budgets verfehlt | Benchmark ist P1-Abnahme; Optionen: weitere Rollup-Stufe, kleinere Kacheln, mehr `shared_buffers` nach Stopp von PulseBot |
| Mac/VPS-Abhängigkeit für Neuberechnungen | Regeländerung erfordert Mac + Transfer | Teilübertragung chunkweise (§2.3); Neu-Download von Binance als Rückfall |
| Transfer komprimierter Chunks per `pg_dump` verhält sich anders als erwartet | Plattenspitze auf dem VPS | Vorab-Test an Test-DB; Rückfall: Teilübertragung chunkweise für alle Tage |
| Binance ändert Routing/Formate/Dateiangebot | Live-Ausfall, fehlende Tagesdateien | Health + Totmann; Endpunkte konfigurierbar; Archiv auf dem Mac |
| trades-Dumps häufiger lückenhaft | Tiefenprüfung oft `reference_unusable` | wird gezählt; Kline-Abgleich bleibt als Prüfung; zusätzliche Stichprobentage |
| Order-Regel liefert andere Größen als DeepCharts | andere Schwellen | Empfindlichkeit dokumentiert (§3.7); Regel versioniert und neu berechenbar |
| DC-Definitionen unvollständig | Abweichungen zu DeepCharts | eigene Definitionen explizit (§6) |
| Plattenplatz VPS durch Spool/WAL/Transfer | Ausfall | Health-Prüfung ≥ 10 GB frei; Importer-Abbruch < 15 GB |

---

## 10. Entscheidungen

### 10.1 Festgelegt

| Thema | Entscheidung |
|---|---|
| Quelle der Wahrheit | aggTrades von Binance Vision (Betrieb: Tagesdateien; Erstimport: Monatsdateien, nach Tag zerlegt); Minute nach T (§3.3) |
| Validierung | Volumen + Taker-Buy gegen Klines mit enger Hülle; Trade-Anzahl nur Referenz; Tiefenprüfung auf Stichprobentagen |
| Rohdaten/Berechnung | Archiv auf dem Mac (+ Backup), Historie auf dem Mac berechnet und übertragen, VPS mit 14-Tage-Fenster |
| Reihenfolge | vertikaler Schnitt BTC zuerst (§8) |
| COT | DeepCharts-Semantik (§3.5) |
| Big Trades | Perzentile ≥ P99, Default `rolling7d` P99,9, Stufen 99,5/99,9/99,97; Order-Regel „gleiche ms + Seite + fortlaufende ID"; Untergrenze per Zwei-Durchlauf; ganzzahliges Notional; erst P5 |
| Tagesgrenze | UTC 00:00, Offset in ganzen Stunden |
| Delta-POC, DC-Elemente ohne Formel | max. \|Delta\|; Single Prints/Bar Ratio/Effort entfallen in v1 |
| PulseBot | wird mit P2 gestoppt (inkl. mongod) |
| Weitere Symbole | später; Kosten je Symbol ab 2025 ≈ 15–25 GB Rohdaten (Mac) + 2–5 GB DB |
| Ops-Alarm | E-Mail an den Nutzer über healthchecks.io-Totmann; Fallback ntfy |
| Zugriff | v1 öffentlich über HTTPS, **ohne Passwort** (§10.2) |

Offene Fragen an den Nutzer gibt es in Fassung 2 keine mehr; offen sind nur Messgrößen, die in den Phasen nachgetragen werden (komprimierte Zeilengröße, Backfill-Dauer, Anteil `big_order`, Transferverhalten von `pg_dump`).

### 10.2 Zugriff (entschieden)

v1 ist **öffentlich über HTTPS erreichbar, ohne Passwortschutz**. Begründung des Nutzers: der VPS ist ein persönliches Pilotprojekt, Last durch Fremde ist unerheblich, ein Verlust des VPS hätte keine ernsten Folgen.

Beibehalten werden Schutzmaßnahmen, die kein Passwort sind und fast nichts kosten. Sie sollen niemanden aussperren, sondern **die App schnell und die Datenbank sicher halten**:
- Postgres nur auf `127.0.0.1` bzw. Unix-Socket (Docker-Portfreigaben umgehen UFW, daher nie `5432:5432`).
- API mit nur lesender DB-Rolle; die API hat keine schreibenden oder administrativen Endpunkte. Import, Neuberechnung, Transfer und Wartung laufen ausschließlich per CLI/systemd auf dem Server.
- Die Guards pro Request (Quellzeilen ≤ 1,5 Mio., Zellen ≤ 30 000/60 000, §5.1) und ein einfaches Rate-Limit je IP in nginx (`limit_req`, `limit_conn`).
- `/api/v1/health` und der Recorder-Feed sind nur lokal erreichbar.

Marktdaten-Weitergabe: Binance Vision hat eigene Nutzungsbedingungen (PDF auf data.binance.vision), deren Text sich in dieser Sitzung nicht auslesen ließ; ein inoffizieller Beitrag im Binance-Entwicklerforum hält öffentliche Marktdaten für allgemein nutzbar. Verbindlich geprüft ist das nicht – kein Blocker für ein privates, öffentlich erreichbares Pilotprojekt, aber vor einer Weitergabe an Dritte oder kommerziellen Nutzung zu lesen.

[später, falls gewünscht] Login: eine echte Login-Seite mit einem festen Passwort, das der Browser speichern kann; Passwort als argon2id- oder bcrypt-Hash in der Datenbank; Session-Cookie `HttpOnly`, `Secure`, `SameSite=Strict`; die API prüft das Cookie auch beim WS-Upgrade. Kein HTTP-Basic-Auth.

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
