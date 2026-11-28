# Runbook: erster Rollout auf den VPS

Alle Befehle laufen **auf dem Mac** im Repo-Wurzelverzeichnis; die Skripte sprechen den Server per
SSH an (`ssh -o BatchMode=yes`). Ziel-Host: `deploy/.env.deploy` (aus `deploy/env.deploy.example`,
git-ignoriert) oder als erstes Argument `root@<host>`. Begründungen: [`README.md`](README.md).

Gesamtdauer ≈ 45–60 min (davon ≈ 15 min Prüfberichte, Upload ≈ 0,85 GB je nach Leitung). Stand der
Daten: BTCUSDT + ETHUSDT je 167 Tage (2026-06-10…2026-11-23), Migration 0012, Mac-DB 1 255 MB.

## Was unangetastet bleiben muss

Auf dem Server werden **nie** verändert, neu gestartet oder umkonfiguriert:

- Docker-Container `genius-live-app-1` (Projekt `genius-live`, Netz `genius-live_default`)
- `takt-backend.service`, `mongod.service` (127.0.0.1:27017), `pm2-root.service` mit
  `pulsebot-ui` und `pulsebot-bot` (`/opt/pulsebot`)
- nginx-Dateien `nginx.conf`, `sites-available/{default,genius.rankyhub.com,rankyhub.com,rankyhub.com.bak.*,takt.rankyhub.com}`,
  ihre Symlinks, `snippets/{fastcgi-php,snakeoil}.conf`, `/etc/nginx/.htpasswd`
- `/etc/letsencrypt/options-ssl-nginx.conf`, `renewal/{genius.rankyhub.com,rankyhub.com,takt.rankyhub.com}.conf`,
  `renewal-hooks/deploy/takt-reload-nginx`, die vorhandenen Zertifikate
- `/etc/docker/daemon.json` (existiert nicht – bleibt so), `docker.service`/`containerd.service`
  (kein Neustart), `/etc/systemd/journald.conf`, System-Node 20 (`/usr/bin/node`), apt-Pakete
  (**keine Installation**), UFW (bleibt aus)
- die Sites antworten wie vorher: genius `http 308 / https 200`, rankyhub `301 / 401`,
  takt `308 / 401`; unbekannter Host → genius (308 bzw. genius-Zertifikat)

Einzige gemeinsam genutzte Eingriffe: **`systemctl reload nginx`** (sanft, Master-PID bleibt; je
zweimal in Schritt 5, jeweils nach `nginx -t`) und **`docker compose pull`** des Timescale-Images.
`preflight.sh` hält den Zustand fest (Unit-Startzeitpunkte, Restart-Zähler, Container-Startzeit,
pm2-Startzeiten, Ports, SHA256 aller obigen Dateien, Statuscodes von innen und außen),
`postcheck.sh` vergleicht nach jedem Schritt und nach jedem Rollback.

## Schritt 0 – Voraussetzungen (Mac)

```bash
cp deploy/env.deploy.example deploy/.env.deploy && $EDITOR deploy/.env.deploy   # OF_DEPLOY_HOST
git status                       # API-Review abgeschlossen, alles committet
npm run check && npm run test:db # grün
npm run db:migrate && npm run db:status   # Mac-DB auf dem Migrationsstand des Releases (z. B. 0010)
```

- Vor dem Rollout nachziehen (siehe README „Offen"): CSP-Endwert in
  `deploy/nginx/orderflow-binance-headers.conf`, Rate-Limit (Stellschrauben 1/2),
  Health-Port/-Pfad in `compose.prod.yml` und `bin/orderflow-monitor`, `sql/harden-db.sql`.
- Während Schritt 3 **keine** Importe/Migrationen gegen die Mac-DB (andere Agenten anhalten):
  der Pflichtvergleich vergleicht den Dump-Zeitpunkt mit dem späteren Prüfbericht der Quelle.

## Schritt 1 – Preflight (nur lesend, ≈ 30 s)

```bash
BASE=$(deploy/preflight.sh)      # bricht ab, wenn etwas fehlt
```

Prüft: Platte ≥ 15 GB frei, MemAvailable ≥ 3,5 GB, Ports 8780/8781/54320 frei, `nginx -t`,
DNS `orderflow.rankyhub.com` (1.1.1.1) = Server-IP, Uhr synchron, `certbot.timer` aktiv und
Let's-Encrypt-Konto vorhanden, Docker-Version; legt die Baseline der Nachbarn ab.
**Rücknahme:** nichts zu tun.

## Schritt 2 – Grundeinrichtung (≈ 3–5 min, davon Image-Pull)

```bash
deploy/install-server.sh
deploy/postcheck.sh "$BASE" --neighbours-only   # 0 = ok; 1 = Nachbarn verändert → sofort Rücknahme; 4 = Produktionsmarker fehlt; 5 = Marker nicht prüfbar (DB läuft nicht)
```

Ändert (nur eigene Pfade): Benutzer/Gruppe `orderflow` (10001), Verzeichnisse
`/opt|/etc|/var/lib/orderflow-binance`, `/var/www/orderflow-acme`, Secrets `db.env`/`api.env`
(nur wenn fehlend), Units `orderflow-monitor.{service,timer}` (noch nicht aktiv), Pull
`timescale/timescaledb:2.31.2-pg17@sha256:2b09…`, Start `orderflow-db` (nur 127.0.0.1:54320).
Prüfung: Skript zeigt `db ok` + `timescaledb 2.31.2`.
**Rücknahme:** `docker compose -p orderflow-binance -f /opt/orderflow-binance/compose.prod.yml --env-file /opt/orderflow-binance/.env down -v`,
`rm -rf /opt/orderflow-binance /etc/orderflow-binance /var/lib/orderflow-binance /var/www/orderflow-acme /etc/systemd/system/orderflow-monitor.*`,
`systemctl daemon-reload`, `userdel orderflow`, `docker image rm timescale/timescaledb:2.31.2-pg17`.
Danach `deploy/postcheck.sh "$BASE" --uninstalled` (nur Nachbarn; bricht mit Exit 5 ab, solange
`/opt/orderflow-binance` oder der Container `orderflow-db` noch existieren).

## Schritt 3 – Datenbank übertragen (≈ 15–25 min)

```bash
deploy/transfer-db.sh
```

1/7 Snapshot exportieren + Dump im Snapshot (lokal ≈ 3 s, ≈ 850 MB, 543 Dateien) · 2/7 Rolleneinstellungen + SHA256SUMS · 3/7 Prüfbericht Quelle
im selben Snapshot (Hintergrund, ≈ 6 min; Jobs/Importe auf dem Mac stören den Vergleich nicht) · 4/7 rsync + `sha256sum -c` auf dem Server · 5/7 Restore (≈ 15–30 s) +
ANALYZE + Prüfbericht Ziel (≈ 8–12 min auf 2 vCPU, lokal 5,5 min; Columnstore-Policies des Ziels sind währenddessen angehalten
und danach wieder aktiv, `jobsched|`-Zeilen vergleichen den Zustand) · **6/7 Pflichtvergleich – bei Abweichung Abbruch mit Exit 1,
weiter erst nach Klärung** · 7/7 Härtung (`harden-db.sql`: PUBLIC ohne CONNECT/TEMP) und Löschen
der Dumps auf beiden Seiten.
Prüfung: Ausgabe `Prüfberichte identisch`, `digest|days=334|match=334|mismatch=0`, `grant|of_api|tables=23|select=16|write=0|…` (ab Quelle 0013 zusätzlich `role|of_recorder|…`,
`grant|of_recorder|…`, `grant_write|of_recorder|…`).
**Rücknahme / Wiederholung:** API stoppen (falls schon gestartet) und
`deploy/transfer-db.sh --replace` (DROP/CREATE der Ziel-DB, dann alles erneut), oder Volume
löschen: `… down -v` und Schritt 2 erneut. Danach `deploy/postcheck.sh "$BASE" --neighbours-only`.

**Daten später ergänzen** (neue Tage/Symbole vom Mac, solange es auf dem VPS keinen Importer gibt):
derzeit nur über `--replace`, also API stoppen → Ziel-DB ersetzen → Prüfbericht → API starten;
≈ 20–25 min ohne API (die Web-Seite zeigt solange Fehler/Retry). Spätere Verbesserung ohne
Ausfall: in eine zweite Datenbank (`orderflow_next`) restaurieren, prüfen, dann per
`ALTER DATABASE … RENAME` tauschen (kurzer API-Neustart) oder Teilübertragung nach KONZEPT §2.3.

## Schritt 4 – Release bauen und ausrollen (Bau ≈ 1–5 min, Rollout ≈ 2 min)

```bash
ID=$(deploy/build-release.sh)    # aus `git archive HEAD` (nie aus dem Arbeitsbaum): Web-Bundle + API-Image linux/amd64
deploy/release.sh "$ID"          # ausstehende Migrationen? → nach Prüfung: deploy/release.sh "$ID" --migrate <genaue Liste>
```

Upload, `sha256sum -c`, `docker load`, Migrationsstand (nach Schritt 3: nichts ausstehend),
Passwort der Rolle `of_api` aus `api.env`, `.env` → `OF_RELEASE=$ID`, `up -d --wait api`
(scheitert der Healthcheck: automatisch zurück auf das vorige Release bzw. API gestoppt),
Symlink `current` atomar, Rauchtest `127.0.0.1:8780/api/v1/symbols` = 200.
Enthält ein Release Migrationen, die (noch) nicht angewendet werden sollen, und verträgt seine API
das alte Schema (vorher am Code prüfen), dann ausdrücklich
`deploy/release.sh "$ID" --allow-pending-migrations 0013,0014`: es wird nichts migriert, und das
Release bricht ab, wenn die ausstehenden Migrationen nicht genau der Liste entsprechen (nicht
zusammen mit `--migrate`).
**Rücknahme:** `deploy/release.sh --rollback` (vorige ID: Image + Web) bzw. beim ersten Release
`… stop api`. Danach `deploy/postcheck.sh "$BASE" --neighbours-only`.

## Schritt 5 – nginx und TLS (≈ 2 min)

```bash
deploy/nginx-setup.sh
```

Installiert `conf.d/orderflow-binance.conf`, `snippets/orderflow-binance-{headers,proxy}.conf`, ACME-Webroot;
Phase 1 (nur ohne Zertifikat): Bootstrap-Site (nur Port 80, ACME) → `nginx -t` → reload →
Probe-Datei über die öffentliche Adresse = 200 → `certbot certonly --account <id> --webroot …`
(das eine Produktionskonto, das die Renewal-Dateien der Nachbarn nutzen; daneben existiert ein
Staging-Konto, ohne `--account` könnte certbot nachfragen; Deploy-Hook nur für diese Lineage); Phase 2: endgültige Site → `nginx -t` → reload.
Schlägt `nginx -t` fehl, nimmt das Skript die eigenen Dateien zurück und lädt **nicht** neu.
Liefert die Challenge-Probe (bis 15 Versuche à ≤ 3 s, verlangt wird der Inhalt der Probe-Datei,
nicht nur Status 200) nicht das Erwartete, bricht das Skript **vor certbot** ab (keine
fehlgeschlagene Let's-Encrypt-Validierung): die Bootstrap-Site (nur Port 80/ACME, alles andere 404)
bleibt aktiv, `conf.d`/Snippets bleiben installiert, Staging- und Backup-Verzeichnis werden
gelöscht. Danach Ursache klären und das Skript erneut starten (idempotent) oder mit
`deploy/nginx-setup.sh --rollback` alles Eigene entfernen; `--rollback` bricht mit Exit 1 ab,
wenn `nginx -t` danach fehlschlägt, und lädt dann nicht neu.
Prüfung (Skript, von innen und vom Mac): `http://` → 308, `https://` → 200,
`/api/v1/symbols` → 200, `/api/v1/health` → 404.
Der Symlink heißt `sites-enabled/zz-orderflow.rankyhub.com`: er sortiert immer zuletzt, unsere
Site wird auf keinem Socket (80, [::]:80, 443, [::]:443) Standardserver; genius bleibt es überall
(Snapshot prüft IPv4 und IPv6, mit und ohne SNI).
Erneuerung testen – **nur** mit Namen, sonst laufen die Hooks der Nachbarn und nginx lädt neu:
`certbot renew --dry-run --cert-name orderflow.rankyhub.com` (Staging; erzeugt ggf. kein neues
Konto, weil das Staging-Konto existiert).
**Rücknahme:** `deploy/nginx-setup.sh --rollback` (entfernt die eigenen Dateien, `nginx -t`,
reload); Zertifikat ggf. `certbot delete --cert-name orderflow.rankyhub.com`.

## Schritt 6 – Monitoring (≈ 1 min)

```bash
deploy/install-server.sh --enable-monitor     # idempotent; schaltet orderflow-monitor.timer ein
```

Prüfung: letzte Journal-Zeile `orderflow healthy (…)`;
`journalctl -u orderflow-monitor.service -f`.
**Rücknahme:** `systemctl disable --now orderflow-monitor.timer`.

## Schritt 7 – Abschlussprüfung (nur lesend)

```bash
deploy/postcheck.sh "$BASE"
```

Exit 0 = alles gut, 1 = Nachbarn verändert (sofort prüfen/zurücknehmen), 3 = Nachbarn unverändert,
eigene Site nicht wie erwartet, 4 = Datenbank ohne Produktionsmarker (`install-server.sh` setzt ihn),
5 = Marker nicht prüfbar (DB-Container fehlt oder Abfrage fehlgeschlagen). Muss bestehen: Nachbarn identisch zur Baseline (Units ohne Neustart, genius-Container gleiche
Startzeit, pm2 ohne Neustart, Ports, Dateien, Statuscodes innen/außen, Standardserver genius),
eigene Site 308/200/200/404, keine Diagnose-Header, keine nginx-Version, alle eigenen Ports nur
auf 127.0.0.1. Danach im Browser `https://orderflow.rankyhub.com/` öffnen (Konsole ohne
CSP-Fehler, Kacheln laden, kein 429 beim Schwenken).

## Später: Recorder-Rollout (Migration 0013 auf einen bei 0012 übertragenen Server) – vorbereitet, nicht ausgeführt

Der Server wurde am 2026-11-25 bei Migration 0012 übertragen; es gibt dort **keine** Rolle
`of_recorder`. Ein Release ab 0013 mit `deploy/release.sh <id> --migrate 0013,…` wendet 0013 über den
ops-Container als `of_admin` an:

- `CREATE ROLE of_recorder` steht in der Migration unter `IF NOT EXISTS` – kein Konflikt mit
  `roles-source.sql`. Achtung: Rollen gelten clusterweit, und auf dem Mac existiert `of_recorder`
  bereits, auch solange `orderflow` noch bei 0012 war. Ein Transfer legt die Rolle dann auf dem
  Server mit LOGIN, aber ohne CONNECT, ohne Passwort und ohne Tabellenrechte an – harmlos (sie kann
  sich nicht anmelden); die Migration ergänzt später Rechte und CONNECT.
- `transfer-db.sh --replace`, wenn die Quell-Cluster die Rolle **nicht** hat, der Server aber
  schon: der Pflichtvergleich bricht laut ab (`role|of_recorder`-Zeile nur auf dem Ziel); dann
  die Lage klären (Rolle auf dem Server bewusst löschen oder auf der Quelle anlegen), nicht
  übergehen.
- `GRANT CONNECT ON DATABASE orderflow TO of_recorder` aus der Migration ist nach der Härtung
  nötig und ausreichend (PUBLIC hat kein CONNECT mehr); TEMPORARY bekommt die Rolle nicht.
  Danach `harden-db.sql` erneut ausführen (idempotent; prüft beide Rollen):
  `docker exec -i orderflow-db psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow < /opt/orderflow-binance/sql/harden-db.sql`.
- Passwort: wie bei der API nur auf dem Server, z. B. `/etc/orderflow-binance/recorder.env`
  (0600, `openssl rand`), gesetzt mit einem Werkzeug analog `api-role-password.ts` (SCRAM-Verifier
  im Client). **Offen, hängt vom Backend ab:** Name der Variablen und des Werkzeugs (es gibt noch
  keins), ob der Recorder als eigener Compose-Dienst (gleiches Image, `apps/recorder` müsste dann
  ins Image) oder als systemd-Unit läuft, und ob eine SECURITY-DEFINER-Funktion bzw.
  Default-Privilegien für `of_recorder` dazukommen (der Prüfbericht vergleicht Tabellenrechte,
  Schreibliste und Ausführungsrechte; Default-ACLs als `default_acl|`-Zeilen).
- **0013–0016 gehören zusammen:** alle müssen angewendet sein, bevor ein neuer Importer oder
  der Recorder läuft (ohne 0014 scheitert eine Chunk-Konvertierung jetzt laut). 0014 setzt
  `recompress: false` auf den Columnstore-Policies, legt die SECURITY-DEFINER-Funktion
  `of_recompress_chunk(regclass)` (Eigentümer `of_admin`, EXECUTE nur für `of_recorder`) an und
  gibt `of_recorder` per Default-Privileg SELECT auf künftige Tabellen. Lokal geprüft: 0013 + 0014
  auf einer bei 0012 übertragenen und gehärteten DB angewendet → `of_recorder` hat danach CONNECT
  nur auf `orderflow`, kein TEMPORARY; `harden-db.sql` erneut ausführen ändert daran nichts.
- **Rohdaten-Fenster des Recorders:** Löschen alter Rohdateien (`OF_RAW_KEEP_DAYS > 0`) verlangt
  die Markierungsdatei `<OF_DATA_DIR>/raw/binance-vision/.of-recorder-raw-cache` und verweigert
  Verzeichnisse mit Monatsdateien. Auf dem VPS die Markierung **vor** `OF_RAW_KEEP_DAYS=14`
  anlegen; im Import-Archiv auf dem Mac darf sie **nie** existieren.
- `transfer-db.sh` funktioniert für Quellen bei 0012, 0013 und 0014 (lokal getestet), ein erneuter
  Transfer (`--replace`) nach dem Recorder-Start würde aber Live-Daten des VPS überschreiben – dann
  nicht mehr ohne Abstimmung verwenden.

### Recorder-Rollout: geordnete Befehlsliste (erst nach bestandener lokaler 25-h-Abnahme)

Ausgangslage: Ein Messskript hat am 2026-11-24 auf dem Mac **alle** Chunks komprimiert, auch noch
offene. Der Transfer überträgt den Komprimierungszustand 1:1 (`chunkrange|`-Zeilen); der VPS hat
diese offenen komprimierten Chunks also sehr wahrscheinlich auch – harmlos, solange niemand
schreibt. Live-Minuten in einen solchen Chunk machten ihn dauerhaft teilweise komprimiert, daher
wird vor dem Recorder repariert.

Alle Befehle vom Mac aus einer **sauberen Arbeitskopie des freigegebenen Commits**
(`git worktree add --detach <dir> <commit>`, `deploy/.env.deploy` hineinkopieren). „Freigabe"
= schreibender Schritt, je eine Bestätigung; alle anderen sind nur lesend.

| #   | Befehl                                                                                                                                                                               | Freigabe | Erwartete Ausgabe / Abbruchkriterium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `BASE=$(deploy/preflight.sh)` (prüft u. a. python3 ≥ 3.7 auf dem Server)                                                                                                             | –        | „Preflight bestanden"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2   | `deploy/install-server.sh`                                                                                                                                                           | 1        | installiert Compose-Datei (neue Dienste `importer`, `recorder` in Profilen – nichts startet; API bekommt `OF_API_RECORDER_EVENTS_URL=http://recorder:7701/events`, wirksam beim API-Neustart in Schritt 4), SQL, `bin/` (u. a. `recorder-ctl.sh`, `hot-chunks.sh`, der erweiterte `orderflow-monitor`), Units; erzeugt `recorder.env` („recorder.env erzeugt"); setzt den **Produktionsmarker** `COMMENT ON DATABASE orderflow IS 'orderflow:production'` (erstmals auf diesem Server); „db ok", „timescaledb 2.31.2". Danach `deploy/postcheck.sh "$BASE" --neighbours-only`                                                               |
| 3   | `ID=$(deploy/build-release.sh <commit>)`                                                                                                                                             | – (Mac)  | Release mit Migrationen bis 0016 und `apps/recorder`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 4   | `deploy/release.sh "$ID" --migrate 0013,0014,0015,0016`                                                                                                                              | 2        | vor allem anderen: Produktionsmarker vorhanden (sonst Abbruch) und Härtung vor den Migrationen; Status: 0001–0012 `angewendet`, ausstehend muss **genau** die `--migrate`-Liste sein (sonst Abbruch und klären); `up 0013…0016`; Härtung mit `dbpriv\|orderflow\|of_recorder_connect=true\|…_temp=false\|…_create=false` und `prodmarker\|true`; „Passwort der Rolle of_api …", „… of_recorder gesetzt" (ab Schema 0013 Pflicht: fehlen `recorder.env` oder das Werkzeug, bricht das Release ab); API healthy (≈ 60 s 503 beim Katalogladen möglich); `current →` neue ID; Recorder **startet nicht**. Danach Postcheck `--neighbours-only` |
| 5   | `deploy/recorder.sh prepare`                                                                                                                                                         | 3        | Datenverzeichnis `/var/lib/orderflow-binance/data` (UID 10001) und Rohdaten-Markierung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | `deploy/recorder.sh hot` und `deploy/recorder.sh repair-dry`                                                                                                                         | –        | Liste offener komprimierter Chunks; prüfen (nur Chunks mit Ende > jetzt − 3 Tage)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 7   | `deploy/recorder.sh report vor-reparatur`                                                                                                                                            | –        | Prüfbericht lokal gespeichert; kein Transfer und keine Reparatur gleichzeitig                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 8   | `deploy/recorder.sh repair`                                                                                                                                                          | 4        | „Rowstore: … Sperre gehalten … ms" je Chunk; verweigert bei laufenden Admin-/psql-/Dump-Sitzungen (einmalige Vorprüfung; der Importer prüft vor jedem Chunk erneut offene Transaktionen). Verweigert sie wegen der kurzen psql-Abfrage des Monitors (alle 5 min), einfach wiederholen. Die API bleibt an; kurze 503 möglich (API `lock_timeout` 1 s, 3 Wiederholungen)                                                                                                                                                                                                                                                                      |
| 9   | `deploy/recorder.sh require-zero`                                                                                                                                                    | –        | „repair-open-chunks: 0 Chunks gefunden", `hot_count\|0` (sonst nicht weiter)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10  | `deploy/recorder.sh report nach-reparatur`, dann `diff <(grep -E '^(digest\|data_day)\|' …/report-vor-reparatur.txt) <(grep -E '^(digest\|data_day)\|' …/report-nach-reparatur.txt)` | –        | identisch (nur diese Zeilen vergleichen; `chunkrange\|…\|true→false` und `info\|` dürfen sich ändern)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 11  | `deploy/recorder.sh catchup-range 2026-11-24 <gestern>`                                                                                                                              | 5        | lädt aggTrades + Klines beider Symbole und importiert `--db --online`; nach 07:30 UTC starten (Tagesdatei erscheint ≈ 07:21 UTC); je Tag „state=final_ok … db=match". Ist eine Tagesdatei noch nicht veröffentlicht, bricht der Lauf ab (bereits importierte Tage bleiben, sie sind fertig); später einfach erneut starten – idempotent (fertige Tage: `UNCHANGED`)                                                                                                                                                                                                                                                                         |
| 12  | `deploy/recorder.sh start`                                                                                                                                                           | 6        | prüft zuerst selbst „keine offenen komprimierten Chunks" (wie Schritt 9, sonst Abbruch ohne Start), startet `orderflow-recorder` und wartet bis „healthy" (≤ 150 min): REST-Nachholen seit 00:00 UTC für beide Symbole, gemessen ≈ 7 Daten-Minuten je Symbol und Minute bei 600 Gewicht/min → Start um 08:00 UTC (8 h Rückstand) ≈ 70 min; daher Schritt 11 direkt nach 07:30 UTC und Schritt 12 sofort danach                                                                                                                                                                                                                              |
| 13  | `deploy/recorder.sh health`                                                                                                                                                          | –        | `healthy:true`, `hotCompressedChunks:0`, `partialChunkAlert:false`, `postCommitErrors:0`, beide Symbole `lastTradeAgeMs` < 120 000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 14  | `deploy/postcheck.sh "$BASE"`                                                                                                                                                        | –        | Exit 0; Recorder „running healthy", kein veröffentlichter Port, auf dem Host lauscht nichts auf 7701; API-Status-Listener zeigt `recorderEvents.connected:true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Monitor: Nach Schritt 2 prüft `orderflow-monitor` auch offene komprimierte Chunks und meldet bis
Schritt 9 „hot compressed chunks: N" (erwartet); nach Schritt 12 zusätzlich Recorder-Health
(nicht healthy, offene Chunks, Alarm zu teilweise komprimierten Chunks, Fehler nach der
Finalisierung, Spool aus). Weiterhin nur Journal, bis eine healthchecks.io-URL hinterlegt ist. Ein mit `recorder.sh stop`
angehaltener Recorder hinterlässt `/opt/orderflow-binance/recorder.stopped`; der Monitor meldet ihn
dann als Hinweis – nur solange der Container seit spätestens 30 s nach der Marke steht (sonst ist
die Marke veraltet und es gibt Alarm) und höchstens 24 h (`OF_RECORDER_STOP_MAX_H`), danach Alarm:
nach einem Tag sind die Live-Daten nur noch über die Tagesdatei zu holen, REST-Lücken über 48 h
sind verloren. Der Postcheck akzeptiert einen angehaltenen Recorder ebenfalls nur mit gültiger
Marke. Den Produktionsmarker der Datenbank verlangt er in jedem Modus, auch mit
`--neighbours-only` (Exit 4, wenn er fehlt; Schritt 2 setzt ihn). Ein nie gestarteter Container
zählt nie als bewusst angehalten; ist der Recorder-Container ganz entfernt, obwohl schon Spool-Daten
existieren, meldet der Monitor Alarm (außer mit einer Haltemarke jünger als 24 h).

**Rücknahme je Schritt:**

- 12–13: `deploy/recorder.sh stop` (Container und Daten bleiben; Neustart mit `start`).
- 11: nichts zurückzunehmen (normale finale Tage; ein erneuter Lauf ist idempotent).
- 8: nicht nötig (Rowstore ist für offene Chunks der richtige Zustand; die Policy komprimiert sie
  nach Ablauf der Frist).
- 4: `deploy/release.sh --rollback` (voriges Release: Image + Web). Die Migrationen 0013–0016
  bleiben (additiv; `down` verweigert eine Datenbank mit Produktionsmarker). Lokal geprüft: die
  API von ba55a90 (= Code des derzeit laufenden 0749081) läuft gegen ein Schema bei 0016 –
  Health, `/symbols`, `/bars` (auch `stats=1`), `/profile`, `/profiles/daily`, `/quality` = 200,
  auch mit vom Recorder geschriebenen Tagen. Schlimmstenfall: Neuübertragung der DB
  (`transfer-db.sh --replace`) – nur vor dem Recorder-Start, sonst gingen Live-Daten verloren.
- 2: `install-server.sh` ist idempotent; die neuen Compose-Dienste starten nie von selbst.

**Harte Regel:** `repair-open-chunks` nie parallel zu `transfer-db.sh` oder einem
`verify-db.sql`-Bericht. `convert_to_rowstore` ist für ältere Snapshots nicht MVCC-sicher: eine
REPEATABLE-READ-Transaktion, die den Chunk noch nicht berührt hat, sähe ihn leer – der
Pflichtvergleich schlüge dann laut fehl (falsche Zeilenzahlen/Digests).

**Transfer und offene Chunks:** `transfer-db.sh`/`restore-db.sh` komprimieren selbst nie. Sie
übertragen den Zustand der Quelle, halten die Columnstore-Policies während des Prüfberichts an
(`alter_job … scheduled => false`) und schalten sie danach wieder ein. Die Policies vergleichen
in TimescaleDB 2.31 mit `range_end` und komprimieren offene Chunks nicht (0015/0016 verschärfen
die Frist auf 4 Tage); bei einem Server vor 0014 steht `recompress` noch auf true, was ohne
Schreibzugriffe dort nichts bewirkt. Wer offene komprimierte Chunks auf dem Server vermeiden will,
repariert die Quelle (Mac) vor dem Transfer oder den Server danach (Abschnitt oben).
`verify-db.sql` meldet die Zahl als `info|hot_compressed_chunks|…` (nur informativ: sie hängt von
der Uhrzeit ab; die harte Prüfung „0" gehört hierher, nicht in einen Transfer).

**Hinweis Transfer:** Dump und Quellbericht halten auf der Mac-DB einen exportierten Snapshot
offen (≈ 6 min bei zwei Symbolen). Sperrende Vorgänge auf `orderflow` (Chunk-Konvertierung,
Lock-Proben) warten so lange; während Schritt 3 nichts dergleichen auf dem Mac starten.

## Release mit Migration 0017 (Big Trades) – vorbereitet, nicht ausgeführt

0017 legt `big_order` an, ergänzt `data_day` (`orders_n`, `orders_notional`, `big_floor_n`,
`digest_version`), setzt die Untergrenzen in `symbol` (BTCUSDT 5·10¹⁰ = 500 000 USDT, ETHUSDT
2,5·10¹¹ = 250 000 USDT) und stellt die Digest-Funktionen auf Version 2 um. Bestehende Tage behalten
ihren Digest als Version 1 (`--verify-db` und `verify-db.sql` prüfen sie in Version 1, ohne
Fehlalarm); der Importer schreibt sie beim nächsten Lauf neu (Grund „Digest-Version 1→2").

Reihenfolge:

1. Außerhalb der Finalisierung (nicht zwischen 06:00 UTC und dem Abschluss des Vortags): ein
   alter Recorder-Prozess würde nach der Migration einen Tag ohne `digest_version` finalisieren
   wollen und scheitert dabei laut (Prüfbedingung `data_day_digest_version`).
2. `deploy/recorder.sh stop`. Der Recorder muss während der Migration nicht zwingend stehen, aber
   so gibt es weder Sperrkonkurrenz noch einen alten Finalisierungslauf.
3. `deploy/release.sh "$ID" --migrate 0017`. 0017 sperrt zuerst `data_day`, dann `symbol`
   (Reihenfolge von Recorder und Importer) mit `lock_timeout = 5s`: hält ein langer Leser die
   Tabellen, bricht die Migration nach 5 s ab (Transaktion zurückgerollt, nichts geändert) –
   einfach erneut ausführen. Danach `SELECT name, big_floor_n FROM symbol` prüfen (beide gesetzt;
   ohne Untergrenze verweigert `import --db` das Schreiben).
4. `deploy/recorder.sh start`. Erster Start für den laufenden Tag: der Recorder spielt die Spool
   des Tages ein und schreibt ab `live_until`. In der ersten geschriebenen Minute vergleicht er den
   Tag im Speicher mit `bar_1m` in der DB (Minuten, Σ Notional, Σ aggTrades, Σ erste/letzte aggId);
   stimmt er, ersetzt er `big_order` für den ganzen Tag aus dem Speicher (also auch die Minuten ab
   00:00, die der alte Recorder ohne big orders geschrieben hat) und setzt Ordersummen und
   Untergrenze. Stimmt er nicht (Spool unvollständig), bleiben Summen und `big_floor_n` NULL – der
   Tag gilt als ohne vollständige Order-Daten, bis der Import ihn finalisiert.
5. Historie: alle Tage einmal neu importieren (Mac, dann Teilübertragung, siehe „Historie Big
   Trades übertragen") – nicht Teil dieses Releases.

Untergrenze ändern: `UPDATE symbol SET big_floor_n = …`. Der Recorder liest sie nur beim Start
(Review O1): danach `deploy/recorder.sh stop` + `start`; der erste Start ersetzt `big_order` des
laufenden Tages mit der neuen Untergrenze (Punkt 4). Finale Tage ändern sich erst beim nächsten
Import (die Untergrenze ist Teil des Digests, sie werden dann neu geschrieben).

## Release Live-Updates Etappe 1 – vorbereitet, nicht ausgeführt

Neu: Live-Tap im Recorder (`GET :7701/live`, nur Compose-Netz), `LiveHub` + `GET /api/v1/live` in
der API (SSE, keine DB), `committedTo` im `/bars`-Header (neue ETags: `RESPONSE_BUILD_VERSION` 3,
einmal alle nicht finalen und finalen Antworten neu – der Server-Cache füllt sich wieder), Web-Overlay.
Keine Migration. Variablen (compose.prod.yml): API `OF_API_RECORDER_LIVE_URL`, `OF_API_LIVE_MAX`
(100; die API verlangt ≤ `OF_API_MAX_CONNECTIONS` − 64 = 192); Recorder `OF_LIVE` (1), `OF_LIVE_HZ` (4). nginx: neue Zone `orderflow_live_conn`
(conf.d/orderflow-binance.conf) und `location = /api/v1/live` im Site-File.

Vorher prüfen (nur lesend):

1. **worker_connections des gemeinsamen nginx:** `nginx -T 2>/dev/null | grep -E 'worker_(processes|connections)'`.
   Jeder Live-Client belegt 2 Verbindungen (Browser + Upstream), dazu kommen die Nachbarn
   (genius, takt, rankyhub). Bei 100 Live-Clients ≈ 200 zusätzlich. Liegt
   `worker_processes × worker_connections` (Debian-Standard 768 je Worker) nicht deutlich darüber
   (≥ 2× der heutigen Spitze + 200), `OF_API_LIVE_MAX` senken statt die globale nginx.conf zu ändern
   (die gehört nicht uns). Aktuelle Spitze: `ss -Htn state established '( sport = :443 )' | wc -l`.
2. Recorder läuft und ist gesund (`deploy/recorder.sh health`), sonst zeigt die Seite nur „getrennt".

Reihenfolge (jede Stufe für sich rückwärtsverträglich: alte Clients ignorieren `committedTo`, eine
neue Seite ohne erreichbaren Live-Strom zeigt „getrennt" und alles andere wie bisher):

1. `ID=$(deploy/build-release.sh)` (Mac).
2. Release ausrollen: `deploy/release.sh "$ID"` (startet die API mit dem neuen Image neu und
   übernimmt compose.prod.yml). Die neue API findet beim alten Recorder noch kein `/live` und
   versucht es mit Backoff (1–30 s) weiter – harmlos.
3. **Sofort danach** den Recorder mit dem neuen Image neu starten: `deploy/recorder.sh stop`, dann
   `deploy/recorder.sh start`. **Nur außerhalb des Finalisierungsfensters** (nicht zwischen 06:00 UTC
   und dem Abschluss des Vortags, siehe `deploy/recorder.sh health` → `lastFinalisedDay`): ein
   Neustart mitten in der Finalisierung bricht diese ab (sie läuft beim nächsten Durchgang erneut,
   dauert dann aber noch einmal). Der Neustart selbst ist billig (Spool-Wiedergabe + REST); die API
   verbindet sich danach von selbst.
4. nginx: `deploy/nginx-setup.sh` (idempotent; `nginx -t` vor dem Reload, bei Fehler werden die
   eigenen Dateien zurückgenommen). Ohne diesen Schritt puffert der bisherige `/api/`-Block die
   SSE-Antwort (proxy_buffering on, 35 s Lese-Zeitlimit) → Live kommt verzögert und reißt ab.

Prüfen:

- Recorder: `deploy/recorder.sh health` → `live.errors` 0, `live.clients` 1 (die API),
  `live.ticks` steigt.
- API (Loopback im Container): `/health` → `live.upstreamConnected: true`, `clients`, `dropped`.
- Von außen (Mac): `curl -sN --max-time 5 https://orderflow.rankyhub.com/api/v1/live?sym=BTCUSDT`
  → sofort `data: {"v":1,"t":"snap"…`, danach `tick`-Zeilen (≥ 1/s, je ≈ 0,2–0,6 kB). Kommt alles
  erst am Ende gebündelt, puffert nginx (Schritt 4 fehlt/falsch).
- `curl -s 'https://orderflow.rankyhub.com/api/v1/bars?sym=BTCUSDT&tf=1m&from=…&to=…' | head -c 400`
  enthält `"committedTo"`.
- Browser: Statuszeile „● live · Preis · V · Δ", die laufende Kerze bewegt sich, nach dem
  Minutenwechsel erscheint die neue Kerze ohne Neuladen; Konsole ohne „Abweichung(en) beim Ablösen".
- 5 Tabs von einer IP: der fünfte bekommt 429 (limit_conn 4) und zeigt „getrennt". Achtung: das
  trifft auch mehrere Nutzer hinter derselben NAT-Adresse (Büro, Mobilfunk-CGNAT); bei Beschwerden
  die Grenze im Site-File anheben (`limit_conn orderflow_live_conn …`) statt die Zone zu ändern.

Abschalten (ohne Release): Recorder `OF_LIVE: '0'` in compose.prod.yml bzw. auf dem Server in
`/opt/orderflow-binance/compose.prod.yml`, `deploy/recorder.sh stop` + `start` – die API meldet den
Clients „Recorder nicht erreichbar", alles andere läuft wie vorher. Nur die API: dort
`OF_API_RECORDER_LIVE_URL` leeren und die API neu starten (`/api/v1/live` → 503).

Rollback: `deploy/release.sh --rollback` (voriges Image + Web), danach `deploy/recorder.sh stop` +
`start` (alter Recorder ohne Tap). Die nginx-Location kann bleiben (ein 404 der alten API geht
ungepuffert durch); vollständig zurück mit dem nginx-Stand des vorigen Releases und
`deploy/nginx-setup.sh`.

## Historie Big Trades übertragen (Teilübertragung, ohne API-Pause) – vorbereitet, nicht ausgeführt

Ausgangslage: Auf dem Mac sind die finalen Tage nach 0017 neu importiert (Digest-Version 2,
`big_order` gefüllt, `orders_n`/`orders_notional`/`big_floor_n` gesetzt); auf dem Server haben
dieselben Tage noch Version 1 ohne Order-Daten. `transfer-db.sh --replace` ersetzte die ganze DB
(20–25 min API-Pause, überschreibt Recorder-Tage) – stattdessen überträgt
`deploy/transfer-bigtrades.sh` **nur** die Big-Trades-Ergänzung, Tag für Tag, neben laufender API
und laufendem Recorder. Aufbau: `bin/bigtrades-export.sh` (Mac, eine lesende Momentaufnahme,
`sql/bigtrades-export.sql`) → rsync nach `/var/lib/orderflow-binance/transfer/bigtrades-<zeit>/` +
`sha256sum -c` → `bigtrades-apply.sh` aus diesem Verzeichnis (`docker exec orderflow-db psql` als
`of_admin`; Nutzlast in **temporäre** Tabellen der Sitzung, `sql/bigtrades-stage.sql`, dann
`sql/bigtrades-run.sql`) → Verzeichnis löschen. Nichts wird vorher auf dem Server installiert.

Ein Tag wird nur geschrieben, wenn auf dem Server: Zustand `final_ok`/`final_bad` wie lokal, nicht
`stale`, kein offener Import, Digest-Version 1 ohne Ordersummen, gespeicherter Digest **und** neu
berechneter `day_digest_all_v(…, 1)` = lokal berechneter v1-Digest (Beweis: die zwölf
Aggregattabellen sind identisch), gleiche Klassifikation (`quality_digest`), und `symbol.big_floor_n`
= lokal (sonst Abbruch des ganzen Laufs, auch im Probelauf). Dann in **einer** Transaktion:
`data_day`-Zeile `FOR UPDATE` → `symbol` `FOR SHARE` (Reihenfolge von Recorder/Importer) →
`big_order` des Tages ersetzen → Ordersummen, Untergrenze, v2-Digest, `digest_version = 2`,
`version + 1` (neue `dataVersion`/ETags; der API-Katalog sieht es nach ≤ `OF_API_POLL_MS`, Standard
1 s) → Σ Notional = Σ `bar_1m.notional` → `day_digest_all_v(…, 2)` = lokaler v2-Digest, sonst
Rücknahme dieses Tages (`fail`). Bereits v2 (übertragen oder vom Recorder finalisiert) → `same`
bzw. `skip`, nie überschrieben. Sperren: Importer-Advisory-Lock 7042025 für den ganzen Lauf (die
Recorder-Finalisierung meldet solange `lock_busy` und versucht es 15 min später erneut), je Tag
`lock_timeout` 2 s (sonst bzw. bei Deadlock `busy`, Tag unverändert). Chunks: direktes DML wie der Importer im
Online-Betrieb (MVCC-sicher für Leser, kein `convert_to_rowstore`); danach unter dem Lock
`of_recompress_chunk` (ACCESS EXCLUSIVE, je Versuch 500 ms, 10 Versuche) für alle teilweise
komprimierten kalten Chunks und die neu angelegten kalten `big_order`-Chunks; offene Chunks bleiben
im Rowstore (0015). Abbruch vor dem Schreiben: Fenster 05:00–06:00 UTC bzw. ab 06:00, solange der
Vortag nicht final ist (`--ignore-window` übergeht das bewusst), offene komprimierte Chunks
(zuerst `deploy/recorder.sh repair`), laufende Admin-/psql-/Dump-Sitzungen (kein Prüfbericht
parallel), Importer-Lock länger als `--lock-wait` (120 s) belegt.

Probelauf und `--verify` sperren je Tag die Chunks des Tages (ACCESS SHARE, wie die API) und
lesen danach mit frischem Snapshot – eine gleichzeitige Chunk-Konvertierung (Finalisierung,
`recorder.sh repair`) erzeugt so keine falsche Abweichung; ein Tag, dessen Sperre nicht binnen 2 s
kommt, erscheint als `busy`.

**Zeitfenster:** 07:00–12:00 UTC, nachdem der Recorder den Vortag finalisiert hat
(`deploy/recorder.sh health` → `lastFinalisedDay` = gestern). Währenddessen **kein**
`recorder.sh report`/`repair`, kein `transfer-db.sh`, kein zweiter Probelauf/`--verify` parallel.

Befehlsfolge (Mac, Repo-Wurzel; Mac-DB währenddessen nicht ändern):

```bash
deploy/recorder.sh health                       # lastFinalisedDay = gestern, healthy
deploy/transfer-bigtrades.sh --dry-run          # nur lesend; Ergebnis lesen (siehe unten)
deploy/transfer-bigtrades.sh                    # Lauf (Abfrage; OF_YES=1 überspringt); Bericht result-apply.txt AUFHEBEN
deploy/transfer-bigtrades.sh --verify           # nur lesend; „verify: N/N Tage v2 identisch", Exit 0
deploy/recorder.sh hot                          # hot_count|0
deploy/recorder.sh report nach-bigtrades        # digest|…|mismatch=0 bis auf provisorische Tage, digest_version|2|…
deploy/postcheck.sh "$BASE"                     # Nachbarn unverändert, Site 200
```

Erwartung des Probelaufs: idealerweise `would` für alle 340 Tage, Exit 0. Das ist **nicht
gesichert**: vom Recorder auf dem Server finalisierte oder neu importierte Tage sind dort schon v2
(→ `same`, bei anderem Digest `skip`), ein Tag mit anderem Zustand oder anderer Klassifikation →
`skip`. Die `skip`-Gründe im Bericht einmal prüfen, bevor der Lauf startet; der Lauf überträgt nur
die `would`-Tage und lässt alle anderen unverändert.

Bericht je Modus: `~/.cache/orderflow-binance/bigtrades/<name>/result-<modus>.txt` (Zeilen
`day|…`, `verify|…`, `chunk|…`, `partial_chunks|0`, `hot_compressed_chunks|0`) und `.err`
(Zusammenfassung, `ABBRUCH: …`, Schlusszeile `ergebnis|exit=…|fail=…|busy=…|skip=…|partial_chunks=…`).
Exit (Vorrang von oben nach unten):

| Exit | Bedeutung                                                                                              | Handlung                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5    | nichts auf dem Server ausgeführt (Argumente, Vorprüfung, Export, Upload/SHA256, Bestätigung abgelehnt) | Meldung lesen, beheben, erneut                                                                                                                          |
| 3    | Abbruch (`ABBRUCH: …`, SSH weg, Sitzung beendet)                                                       | Meldung lesen; festgeschriebene Tage sind gültig; erneut ausführen                                                                                      |
| 1    | `fail` (Gegenprobe gescheitert, Tag zurückgerollt) bzw. verify-Abweichung                              | nicht übergehen: Tag lokal und auf dem Server prüfen                                                                                                    |
| 4    | Chunks teilweise komprimiert geblieben                                                                 | erneut ausführen; sonst meldet der Recorder nach 1 h `partialChunkAlert`, und die nächste Finalisierung verdichtet sie ohnehin (`PostgresWriter.close`) |
| 6    | `busy`: Tage vorübergehend gesperrt, unverändert                                                       | denselben Befehl erneut ausführen                                                                                                                       |
| 2    | `skip`: Tage passen dauerhaft nicht, unverändert                                                       | Gründe einmal prüfen; Wiederholung ändert daran nichts                                                                                                  |
| 0    | alles übertragen bzw. identisch                                                                        | –                                                                                                                                                       |

Dauer und Menge (gemessen am 2026-11-28 lokal an einer Kopie der Mac-DB in Server-Zustand – alle
340 Tage v1, keine historischen `big_order`-Chunks –, Container mit 2 CPUs/2 GB; 1 305 965 big
orders): Export ≈ 1,5 min je Modus (v1 + v2 aller Tage), Nutzlast 36 MB gzip (118 MB roh; für
`--dry-run`/`--verify` 128 KB); Probelauf ≈ 45 s, Lauf ≈ 90 s (je Tag ≤ 1 s Transaktion, 5 neue
kalte `big_order`-Chunks je ≈ 0,1 s komprimiert, danach `partial_chunks|0`), verify ≈ 45 s;
Wiederholung ≈ 2 s (340 × `same`). Auf dem VPS (2 vCPU, geteilt) mit ≈ 2× rechnen: Lauf
einschließlich Export und Upload ≈ 5–8 min. Der Lauf hält den Importer-Lock die ganze Zeit;
außerhalb des Finalisierungsfensters starten.

**Abbruch** (Strg-C, SSH weg, Exit 3/4): `bigtrades-apply.sh` beendet dann die eigene Server-Sitzung
(`pg_terminate_backend`, sobald die Ausgabe ins Leere geht bzw. bei HUP/INT/TERM) – der laufende
Tag wird zurückgerollt, Lock und temporäre Tabellen verschwinden; festgeschriebene Tage sind
vollständig (v2, geprüft). Während des Wartens auf den Lock gibt es keine Ausgabe; dort kann das
Ende bis zu `--lock-wait` dauern. Prüfen und notfalls von Hand beenden (auf dem Server):
`docker exec orderflow-db psql -U of_admin -d orderflow -Atc "SELECT pid, state FROM pg_stat_activity WHERE application_name = 'orderflow-bigtrades'"`
bzw. `… -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'orderflow-bigtrades'"`.
Kalte Chunks können teilweise komprimiert bleiben (lesbar, konsistent; auch wenn vor dem
Chunk-Abschluss eine andere lange Transaktion offen war: `check|chunk_abschluss|zurückgestellt`,
Exit 4; ohne Eingriff meldet der Recorder nach 1 h `partialChunkAlert`, die nächste Finalisierung
räumt auf). Abhilfe: denselben Befehl erneut ausführen – übertragene Tage melden `same`, der Rest wird
übertragen, der Chunk-Abschluss läuft erneut; danach `--verify`. Bleibt ein Transferverzeichnis
liegen: `rm -rf /var/lib/orderflow-binance/transfer/bigtrades-*` auf dem Server.
**Rücknahme** (`--revert`, nur für Tage, die ein Lauf mit `ok` gemeldet hat):

```bash
deploy/transfer-bigtrades.sh --revert ~/.cache/orderflow-binance/bigtrades/<name>/result-apply.txt
deploy/transfer-bigtrades.sh --verify           # zurückgenommene Tage erscheinen als v1
```

Gleiche Vorprüfungen und Sperren wie der Lauf (Importer-Lock 7042025, Fenster, Chunk-Prüfungen).
Je Tag der Liste in einer Transaktion: Chunks des Tages ROW EXCLUSIVE, `data_day` `FOR UPDATE`;
nur wenn der Tag **noch genau den übertragenen Stand** hat (`digest_version = 2` und `digest` =
v2-Digest der Nutzlast, sonst `skip`, unverändert): `DELETE FROM big_order` des Tages,
`UPDATE data_day SET orders_n = NULL, orders_notional = NULL, big_floor_n = NULL, digest = day_digest_all_v(sym_id, day, 1), digest_version = 1, version = version + 1`
und Gegenprobe neuer v1-Digest = v1-Beweis-Schlüssel (sonst zurück, `fail`); danach Chunk-Abschluss
(`of_recompress_chunk` für teilweise komprimierte Chunks). Der Stand entspricht dann wieder dem nach
Migration 0017: der Importer (bzw. ein erneuter Lauf dieses Werkzeugs) würde die Tage regulär neu
in Version 2 schreiben („Digest-Version 1→2"). Die Aggregattabellen werden weder beim Lauf noch bei
der Rücknahme verändert.

## Nach dem Rollout – wichtig

- **Niemand wird alarmiert.** Der Monitor schreibt nur ins Journal (und markiert die Unit als
  „failed"). Der externe Totmann (healthchecks.io, E-Mail an den Nutzer, KONZEPT §2.5) ist
  vorbereitet, aber **aus**, bis der Nutzer eine Ping-URL gibt; dann auf dem Server:
  `umask 077; echo 'HC_PING_URL=https://hc-ping.com/<uuid>' > /etc/orderflow-binance/healthcheck.env`
  (der nächste Timer-Lauf pingt).
- Rate-Limit je IPv6-Adresse auf /128 (ein Client mit /64 kann es umgehen; später per `map` auf
  /64 kürzen, falls nötig).
- Die Daten enden am 2026-11-23; ergänzen siehe Schritt 3 („Daten später ergänzen").

## Alle zustandsändernden Befehle auf dem Server (zur Freigabe)

| Schritt | Befehl(e)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2       | `groupadd --system --gid 10001 orderflow`; `useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin orderflow`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2       | `install -d` `/opt/orderflow-binance{,/bin,/sql,/releases}`, `/var/www/orderflow-acme` (0755), `/etc/orderflow-binance`, `/var/lib/orderflow-binance{,/transfer}` (0700); Kopien nach `/opt/orderflow-binance/{compose.prod.yml,sql/*,bin/*}`, `.env` (`OF_RELEASE=none`); Staging `/root/.orderflow-binance-stage` (danach gelöscht)                                                                                                                                                                                                                                                                                                   |
| 2       | Secrets erzeugen (nur wenn fehlend): `/etc/orderflow-binance/db.env`, `api.env` (0600, `openssl rand`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2       | `install` `/etc/systemd/system/orderflow-monitor.{service,timer}`; `systemctl daemon-reload`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2       | `docker compose -p orderflow-binance … pull db`; `… up -d --wait db` (legt Netz `orderflow-binance_net`, Volume `orderflow-binance_pgdata`, Container `orderflow-db` an)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3       | `mkdir /var/lib/orderflow-binance/transfer/<dump>`; `rsync` dorthin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3       | `restore-db.sh`: `psql` roles.sql + roles-source.sql (`CREATE ROLE of_api`, `ALTER ROLE of_api …`), `CREATE EXTENSION IF NOT EXISTS timescaledb`, `timescaledb_pre_restore()`, `pg_restore`, `alter_job(…, scheduled => false)` für die Policies, post-restore.sql (`timescaledb_post_restore()`, `GRANT CONNECT`), `vacuumdb --analyze-only`, nach dem Bericht `alter_job(…, scheduled => true)`; nur bei `--replace`: `DROP DATABASE orderflow WITH (FORCE)`, `CREATE DATABASE orderflow`                                                                                                                                             |
| 3       | `psql` harden-db.sql (`REVOKE CONNECT, TEMPORARY ON DATABASE orderflow/postgres/template1 FROM PUBLIC`, `GRANT …` an of_admin/of_api); `rm -rf /var/lib/orderflow-binance/transfer/<dump>`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4       | `mkdir` + `rsync` `/opt/orderflow-binance/releases/<id>/`; `docker load`; `rm api-image.tar.gz`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4       | `docker compose … run --rm ops node packages/db/src/cli.ts status` (nur mit `--migrate <Liste>` und genau dieser Menge ausstehend: `… up`); `… run --rm ops node apps/api/src/cli/api-role-password.ts` (`ALTER ROLE of_api PASSWORD …`)                                                                                                                                                                                                                                                                                                                                                                                                |
| 4       | `.env` schreiben; `docker compose … up -d --wait api` (Container `orderflow-api`, 127.0.0.1:8780); `ln -sfn` + `mv -Tf` `/opt/orderflow-binance/current`; Aufräumen alter Releases/Images `orderflow-api:<alt>`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| R2      | Recorder-Rollout Schritt 2 (`install-server.sh` erneut): wie Schritt 2 oben, zusätzlich `/etc/orderflow-binance/recorder.env` erzeugen (nur wenn fehlend, 0600), `bin/recorder-ctl.sh`, `bin/hot-chunks.sh`, erweiterter `orderflow-monitor`, neue `compose.prod.yml` (Dienste `importer`, `recorder` in Profilen), `COMMENT ON DATABASE orderflow IS 'orderflow:production'`                                                                                                                                                                                                                                                           |
| R4      | `release.sh … --migrate 0013,0014,0015,0016`: Marker-Prüfung, `harden-db.sql` vor und nach `cli.ts up`, `cli.ts up` (genau die Liste), `api-role-password.ts`, `recorder-role-password.ts` (ALTER ROLE of_recorder PASSWORD, SCRAM-Verifier), API-Neustart; läuft ein Recorder: Image-Probe `docker run --rm --network none --entrypoint test orderflow-api:<id> -f apps/recorder/src/main.ts`; mit Recorder `--profile recorder up -d recorder` und bis zu 10 min Warten auf „healthy" (sonst lauter Fehler, API/Web sind dann schon umgestellt), ohne Recorder `stop recorder` + Haltemarke `/opt/orderflow-binance/recorder.stopped` |
| R5      | `recorder-ctl.sh prepare`: `install -d` `/var/lib/orderflow-binance/data{,/raw,/raw/binance-vision,/live}` (UID 10001), Markierung `raw/binance-vision/.of-recorder-raw-cache`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R8      | `recorder-ctl.sh repair`: `importer repair-open-chunks --lock-timeout-ms 500` (je offenem komprimiertem Chunk `LOCK … ACCESS EXCLUSIVE` + `convert_to_rowstore`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R11     | `recorder-ctl.sh catchup-range FROM TO`: `importer download` (aggTrades, Klines) nach `/var/lib/orderflow-binance/data/raw`, `importer import … --db --online`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R12     | `recorder-ctl.sh start`: `--profile recorder up -d recorder` (Container `orderflow-recorder`, kein Host-Port), entfernt die Haltemarke                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| –       | `recorder-ctl.sh stop` (Rücknahme): `--profile recorder stop recorder`, schreibt die Haltemarke `/opt/orderflow-binance/recorder.stopped`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| –       | Jeder Restore (`restore-db.sh`, auch `transfer-db.sh --replace`): `post-restore.sql` setzt den Produktionsmarker neu; `--replace` verlangt gestoppte API **und** gestoppten Recorder                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5       | `install` `/etc/nginx/conf.d/orderflow-binance.conf`, `/etc/nginx/snippets/orderflow-binance-headers.conf`, `/etc/nginx/snippets/orderflow-binance-proxy.conf`, `/etc/nginx/sites-available/orderflow.rankyhub.com` (erst Bootstrap, dann endgültig), `ln -sfn` nach `sites-enabled/zz-orderflow.rankyhub.com`; Probe-Datei im ACME-Webroot (wieder gelöscht)                                                                                                                                                                                                                                                                           |
| 5       | `nginx -t && systemctl reload nginx` (zweimal)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 5       | `certbot certonly --account <id aus renewal/*.conf> --webroot -w /var/www/orderflow-acme -d orderflow.rankyhub.com --cert-name orderflow.rankyhub.com --non-interactive --keep-until-expiring --deploy-hook 'nginx -t && systemctl reload nginx'` (legt `/etc/letsencrypt/{live,archive,renewal}/orderflow.rankyhub.com*` an)                                                                                                                                                                                                                                                                                                           |
| 6       | `systemctl enable --now orderflow-monitor.timer`; `systemctl start orderflow-monitor.service`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| BT      | `transfer-bigtrades.sh` (nicht mit `--dry-run`/`--verify`, die nur lesen und nur Sitzungs-temporäre Tabellen/Funktionen anlegen): `mkdir` + `rsync` (0700/0600) `/var/lib/orderflow-binance/transfer/bigtrades-<zeit>/`; `psql` als of_admin: `pg_advisory_lock(7042025)` (Importer-Lock), je Tag `LOCK` der Chunks des Tages, `DELETE`/`INSERT` `big_order` des Tages und `UPDATE data_day SET orders_n, orders_notional, big_floor_n, digest, digest_version = 2, version + 1`; `of_recompress_chunk(…)` für teilweise komprimierte bzw. neu angelegte kalte Chunks; `rm -rf` des Transferverzeichnisses                              |
| BT-R    | `transfer-bigtrades.sh --revert <result-apply.txt>`: wie BT, je Tag der Liste (nur bei unverändertem übertragenem Stand) `DELETE` `big_order` des Tages und `UPDATE data_day SET orders_n = NULL, orders_notional = NULL, big_floor_n = NULL, digest = day_digest_all_v(…, 1), digest_version = 1, version + 1`; `of_recompress_chunk(…)`                                                                                                                                                                                                                                                                                               |

## Risiken für die Nachbardienste und Schutz

| Risiko                                                         | Schutz                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speicher: kein Swap, globaler OOM könnte genius/mongod treffen | harte Limits (DB 2 GB, API 600 MB, Recorder 1,5 GB), `oom_score_adj` 300/500 für unsere Container, Preflight ≥ 3,5 GB verfügbar, Monitor warnt < 500 MB |
| CPU (2 vCPU geteilt)                                           | `cpus` 1.5 / 1.0, parallele Worker begrenzt; Prüfbericht/Restore sind kurz                                                                              |
| Offene Ports (UFW aus)                                         | alle Docker-Ports an 127.0.0.1; Postcheck prüft das                                                                                                     |
| nginx-Reload trifft alle Sites                                 | vorher immer `nginx -t`, bei Fehler eigene Dateien zurück und kein Reload; kein Neustart; Master-PID im Postcheck                                       |
| Standardserver kippt                                           | kein `default_server`, kein server-Block in conf.d, Symlink `zz-orderflow.rankyhub.com` sortiert zuletzt; Postcheck prüft unbekannten Host              |
| HTTP/2 oder Socket-Optionen ändern Nachbarn                    | bewusst nicht gesetzt (Entscheidung offen)                                                                                                              |
| certbot fasst andere Zertifikate an                            | nur `certonly --cert-name orderflow…`, Webroot, Deploy-Hook in der eigenen Renewal-Datei; Postcheck vergleicht Renewal-Dateien und Ablaufdaten          |
| Docker-Namenskonflikte                                         | eigener Projektname, Präfix `orderflow-` für Container/Netz/Volume; Preflight prüft                                                                     |
| Docker-Logs füllen die Platte                                  | journald-Treiber nur für unsere Container (daemon.json unverändert)                                                                                     |
| Platte                                                         | Dump ≈ 0,85 GB, DB ≈ 1,2 GB, Image-Pull ≈ 1 GB; Preflight ≥ 15 GB; Dumps werden gelöscht                                                                |
| Node 20 von PulseBot                                           | kein Node auf dem Host installiert, API im Container                                                                                                    |
| Unattended-Upgrades starten Docker/nginx neu                   | außerhalb unserer Kontrolle; Postcheck zeigt es (Startzeitpunkte) – dann nicht uns zuschreiben, sondern im Journal prüfen                               |
