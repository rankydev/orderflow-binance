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
deploy/postcheck.sh "$BASE" --neighbours-only   # Exit 0 = Nachbarn unverändert; Exit 1 = sofort Rücknahme
```

Ändert (nur eigene Pfade): Benutzer/Gruppe `orderflow` (10001), Verzeichnisse
`/opt|/etc|/var/lib/orderflow-binance`, `/var/www/orderflow-acme`, Secrets `db.env`/`api.env`
(nur wenn fehlend), Units `orderflow-monitor.{service,timer}` (noch nicht aktiv), Pull
`timescale/timescaledb:2.31.2-pg17@sha256:2b09…`, Start `orderflow-db` (nur 127.0.0.1:54320).
Prüfung: Skript zeigt `db ok` + `timescaledb 2.31.2`.
**Rücknahme:** `docker compose -p orderflow-binance -f /opt/orderflow-binance/compose.prod.yml --env-file /opt/orderflow-binance/.env down -v`,
`rm -rf /opt/orderflow-binance /etc/orderflow-binance /var/lib/orderflow-binance /var/www/orderflow-acme /etc/systemd/system/orderflow-monitor.*`,
`systemctl daemon-reload`, `userdel orderflow`, `docker image rm timescale/timescaledb:2.31.2-pg17`.

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
deploy/release.sh "$ID"          # ausstehende Migrationen? → nach Prüfung: deploy/release.sh "$ID" --migrate
```

Upload, `sha256sum -c`, `docker load`, Migrationsstand (nach Schritt 3: nichts ausstehend),
Passwort der Rolle `of_api` aus `api.env`, `.env` → `OF_RELEASE=$ID`, `up -d --wait api`
(scheitert der Healthcheck: automatisch zurück auf das vorige Release bzw. API gestoppt),
Symlink `current` atomar, Rauchtest `127.0.0.1:8780/api/v1/symbols` = 200.
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
eigene Site nicht wie erwartet. Muss bestehen: Nachbarn identisch zur Baseline (Units ohne Neustart, genius-Container gleiche
Startzeit, pm2 ohne Neustart, Ports, Dateien, Statuscodes innen/außen, Standardserver genius),
eigene Site 308/200/200/404, keine Diagnose-Header, keine nginx-Version, alle eigenen Ports nur
auf 127.0.0.1. Danach im Browser `https://orderflow.rankyhub.com/` öffnen (Konsole ohne
CSP-Fehler, Kacheln laden, kein 429 beim Schwenken).

## Später: Recorder-Rollout (Migration 0013 auf einen bei 0012 übertragenen Server) – vorbereitet, nicht ausgeführt

Der Server wurde am 2026-11-25 bei Migration 0012 übertragen; es gibt dort **keine** Rolle
`of_recorder`. Ein Release ab 0013 mit `deploy/release.sh <id> --migrate` wendet 0013 über den
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

### Offene Chunks im Columnstore reparieren (vor dem Recorder-Start, Pflicht)

Ausgangslage: Ein Messskript hat am 2026-11-24 auf dem Mac **alle** Chunks komprimiert, auch noch
offene (Zeitraum nicht seit 3 Tagen vorbei). Der Transfer überträgt den Komprimierungszustand 1:1
(`pg_restore` legt die Chunks so an, wie sie auf der Quelle waren; der Pflichtvergleich prüft das
über die `chunkrange|`-Zeilen). Der VPS hat diese offenen komprimierten Chunks also sehr
wahrscheinlich auch – harmlos, solange niemand schreibt. Live-Minuten in einen solchen Chunk
machten ihn dauerhaft teilweise komprimiert, daher vor dem Recorder:

1. Recorder läuft nicht (Unit/Dienst gestoppt bzw. noch nicht eingerichtet).
2. Migrationen 0013–0016 zusammen anwenden (`release.sh <id> --migrate` mit einem Release, das
   alle vier enthält); ab 0015 komprimieren weder Importer noch `of_recompress_chunk` offene
   Chunks, ab 0016 steht die Marge in `of_hot_margin()` (Policies: `compress_after` 4 Tage).
3. Bestand ansehen (nur lesend): `/opt/orderflow-binance/bin/hot-chunks.sh` bzw. ohne Installation
   `docker exec -i orderflow-db psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow < /opt/orderflow-binance/sql/hot-chunks.sql`.
4. Probelauf und Liste prüfen:
   `docker compose … run --rm ops node apps/importer/src/main.ts repair-open-chunks --dry-run </dev/null`
   (als `of_admin`, ops-Container; das Image muss `apps/importer` enthalten – tut es).
5. Reparatur: `… repair-open-chunks --lock-timeout-ms 500 </dev/null`. Je Chunk eine Transaktion
   mit `LOCK … ACCESS EXCLUSIVE` + `convert_to_rowstore` (auf dem Mac: 9 Chunks, längste Sperre
   824 ms, Digests unverändert). Die API bleibt an; kurze 503 sind möglich (API: `lock_timeout`
   1 s, 3 Wiederholungen), der Client wiederholt sie.
6. Zweiter Probelauf muss **0** melden; `hot-chunks.sh --require-zero` muss Exit 0 liefern.
7. Prüfbericht vorher/nachher: `verify-db.sql` auf dem Server vor Schritt 5 und nach Schritt 6;
   die `digest|`- und `data_day|`-Zeilen müssen identisch sein (nur `chunkrange|…|true → false`
   der reparierten Chunks und `info|`-Zeilen dürfen sich ändern).
8. Erst dann den Recorder starten und in seinem Health `hotCompressedChunks: 0` verlangen.

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

| Schritt | Befehl(e)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2       | `groupadd --system --gid 10001 orderflow`; `useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin orderflow`                                                                                                                                                                                                                                                                                                                                                  |
| 2       | `install -d` `/opt/orderflow-binance{,/bin,/sql,/releases}`, `/var/www/orderflow-acme` (0755), `/etc/orderflow-binance`, `/var/lib/orderflow-binance{,/transfer}` (0700); Kopien nach `/opt/orderflow-binance/{compose.prod.yml,sql/*,bin/*}`, `.env` (`OF_RELEASE=none`); Staging `/root/.orderflow-binance-stage` (danach gelöscht)                                                                                                                                                       |
| 2       | Secrets erzeugen (nur wenn fehlend): `/etc/orderflow-binance/db.env`, `api.env` (0600, `openssl rand`)                                                                                                                                                                                                                                                                                                                                                                                      |
| 2       | `install` `/etc/systemd/system/orderflow-monitor.{service,timer}`; `systemctl daemon-reload`                                                                                                                                                                                                                                                                                                                                                                                                |
| 2       | `docker compose -p orderflow-binance … pull db`; `… up -d --wait db` (legt Netz `orderflow-binance_net`, Volume `orderflow-binance_pgdata`, Container `orderflow-db` an)                                                                                                                                                                                                                                                                                                                    |
| 3       | `mkdir /var/lib/orderflow-binance/transfer/<dump>`; `rsync` dorthin                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3       | `restore-db.sh`: `psql` roles.sql + roles-source.sql (`CREATE ROLE of_api`, `ALTER ROLE of_api …`), `CREATE EXTENSION IF NOT EXISTS timescaledb`, `timescaledb_pre_restore()`, `pg_restore`, `alter_job(…, scheduled => false)` für die Policies, post-restore.sql (`timescaledb_post_restore()`, `GRANT CONNECT`), `vacuumdb --analyze-only`, nach dem Bericht `alter_job(…, scheduled => true)`; nur bei `--replace`: `DROP DATABASE orderflow WITH (FORCE)`, `CREATE DATABASE orderflow` |
| 3       | `psql` harden-db.sql (`REVOKE CONNECT, TEMPORARY ON DATABASE orderflow/postgres/template1 FROM PUBLIC`, `GRANT …` an of_admin/of_api); `rm -rf /var/lib/orderflow-binance/transfer/<dump>`                                                                                                                                                                                                                                                                                                  |
| 4       | `mkdir` + `rsync` `/opt/orderflow-binance/releases/<id>/`; `docker load`; `rm api-image.tar.gz`                                                                                                                                                                                                                                                                                                                                                                                             |
| 4       | `docker compose … run --rm ops node packages/db/src/cli.ts status` (nur mit `--migrate`: `… up`); `… run --rm ops node apps/api/src/cli/api-role-password.ts` (`ALTER ROLE of_api PASSWORD …`)                                                                                                                                                                                                                                                                                              |
| 4       | `.env` schreiben; `docker compose … up -d --wait api` (Container `orderflow-api`, 127.0.0.1:8780); `ln -sfn` + `mv -Tf` `/opt/orderflow-binance/current`; Aufräumen alter Releases/Images `orderflow-api:<alt>`                                                                                                                                                                                                                                                                             |
| 5       | `install` `/etc/nginx/conf.d/orderflow-binance.conf`, `/etc/nginx/snippets/orderflow-binance-headers.conf`, `/etc/nginx/snippets/orderflow-binance-proxy.conf`, `/etc/nginx/sites-available/orderflow.rankyhub.com` (erst Bootstrap, dann endgültig), `ln -sfn` nach `sites-enabled/zz-orderflow.rankyhub.com`; Probe-Datei im ACME-Webroot (wieder gelöscht)                                                                                                                               |
| 5       | `nginx -t && systemctl reload nginx` (zweimal)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5       | `certbot certonly --account <id aus renewal/*.conf> --webroot -w /var/www/orderflow-acme -d orderflow.rankyhub.com --cert-name orderflow.rankyhub.com --non-interactive --keep-until-expiring --deploy-hook 'nginx -t && systemctl reload nginx'` (legt `/etc/letsencrypt/{live,archive,renewal}/orderflow.rankyhub.com*` an)                                                                                                                                                               |
| 6       | `systemctl enable --now orderflow-monitor.timer`; `systemctl start orderflow-monitor.service`                                                                                                                                                                                                                                                                                                                                                                                               |

## Risiken für die Nachbardienste und Schutz

| Risiko                                                         | Schutz                                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Speicher: kein Swap, globaler OOM könnte genius/mongod treffen | harte Limits (DB 2 GB, API 600 MB), `oom_score_adj` 300/500 für unsere Container, Preflight ≥ 3,5 GB verfügbar, Monitor warnt < 500 MB         |
| CPU (2 vCPU geteilt)                                           | `cpus` 1.5 / 1.0, parallele Worker begrenzt; Prüfbericht/Restore sind kurz                                                                     |
| Offene Ports (UFW aus)                                         | alle Docker-Ports an 127.0.0.1; Postcheck prüft das                                                                                            |
| nginx-Reload trifft alle Sites                                 | vorher immer `nginx -t`, bei Fehler eigene Dateien zurück und kein Reload; kein Neustart; Master-PID im Postcheck                              |
| Standardserver kippt                                           | kein `default_server`, kein server-Block in conf.d, Symlink `zz-orderflow.rankyhub.com` sortiert zuletzt; Postcheck prüft unbekannten Host     |
| HTTP/2 oder Socket-Optionen ändern Nachbarn                    | bewusst nicht gesetzt (Entscheidung offen)                                                                                                     |
| certbot fasst andere Zertifikate an                            | nur `certonly --cert-name orderflow…`, Webroot, Deploy-Hook in der eigenen Renewal-Datei; Postcheck vergleicht Renewal-Dateien und Ablaufdaten |
| Docker-Namenskonflikte                                         | eigener Projektname, Präfix `orderflow-` für Container/Netz/Volume; Preflight prüft                                                            |
| Docker-Logs füllen die Platte                                  | journald-Treiber nur für unsere Container (daemon.json unverändert)                                                                            |
| Platte                                                         | Dump ≈ 0,85 GB, DB ≈ 1,2 GB, Image-Pull ≈ 1 GB; Preflight ≥ 15 GB; Dumps werden gelöscht                                                       |
| Node 20 von PulseBot                                           | kein Node auf dem Host installiert, API im Container                                                                                           |
| Unattended-Upgrades starten Docker/nginx neu                   | außerhalb unserer Kontrolle; Postcheck zeigt es (Startzeitpunkte) – dann nicht uns zuschreiben, sondern im Journal prüfen                      |
