# Deployment auf den VPS (orderflow.rankyhub.com)

Produktionsbetrieb von Datenbank, API und Web auf dem geteilten VPS (KONZEPT §2.3–§2.5, §10.2).
Ablauf und Befehle: [`RUNBOOK.md`](RUNBOOK.md). Hier stehen Bestandsaufnahme, Entscheidungen und
Begründungen. Stand: 2026-11-25, vorbereitet, **noch nicht ausgerollt**.

Erste Ausbaustufe: nur DB (übertragene Historie BTCUSDT 2026-06-10…2026-11-23), lesende API, Web.
**Kein** Recorder und **kein** täglicher Import auf dem VPS (spätere Phase); die Daten enden am
2026-11-23.

## Bestandsaufnahme des Servers (nur lesend, 2026-11-24)

| Thema          | Befund                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System         | Ubuntu 22.04.5, Kernel 5.15, 2 vCPU, 7,8 GB RAM (≈ 5,4 GB verfügbar), **kein Swap**, 97 GB Platte / 80 GB frei (ext4, Docker-Root `/var/lib/docker` auf derselben Platte)                                                                                                                                                                       |
| Zeit           | UTC, systemd-timesyncd aktiv, synchron                                                                                                                                                                                                                                                                                                          |
| Firewall       | **UFW inaktiv**, iptables INPUT ACCEPT → alles, was auf 0.0.0.0 lauscht, ist öffentlich. Docker-Ports daher ausnahmslos an 127.0.0.1                                                                                                                                                                                                            |
| Belegte Ports  | 22, 80, 443 (nginx), `*:3000` (PulseBot-UI, öffentlich!), 127.0.0.1: 8000 (genius, docker-proxy), 8787 (takt), 27017 (mongod), 53 (resolved). **Frei für uns: 8780 (API), 54320 (DB)**                                                                                                                                                          |
| Docker         | Engine 29.9.2, Compose v5.7.0, cgroup v2 + systemd, Log-Treiber json-file **ohne Größenlimit** (kein daemon.json), ein Projekt `genius-live` (Container `genius-live-app-1`, Netz `genius-live_default`, keine Volumes)                                                                                                                         |
| Node           | **v20.20.2 systemweit** (NodeSource-Paket, von pm2/PulseBot genutzt); kein nvm. Projekt braucht Node 24                                                                                                                                                                                                                                         |
| nginx          | 1.18.0 (Ubuntu-Paket): `http_ssl`, `http_v2`, `realip`, `gzip_static`, gzip (Standard), `limit_req`/`limit_conn` (Standard); **kein Brotli**, **kein HTTP/3**; dynamisch: geoip2, image-filter, xslt, mail, stream                                                                                                                              |
| nginx-Layout   | `nginx.conf` unverändert (Ubuntu-Standard: `gzip on` ohne `gzip_types`, `server_tokens` nicht gesetzt = an); `conf.d/` leer; `sites-enabled/`: genius.rankyhub.com, rankyhub.com, takt.rankyhub.com (Symlinks); `default` liegt nur in sites-available                                                                                          |
| Standardserver | kein `default_server` → der erste Server je Socket in Include-Reihenfolge = **genius.rankyhub.com** (unbekannter Host: Port 80 → 308 auf genius, 443 → genius-Zertifikat). `conf.d` wird vor `sites-enabled` eingebunden, ein server-Block in conf.d würde Standardserver                                                                       |
| TLS            | certbot 1.21 (Paket) + `certbot.timer` (2×/Tag). genius und takt: **webroot** (`/var/www/<name>-acme`, Site-Files von Hand); rankyhub.com: nginx-Plugin. Gemeinsam `options-ssl-nginx.conf` + `ssl-dhparams.pem`. Deploy-Hook nur für takt (`takt-reload-nginx`, auf die Lineage beschränkt). Zertifikate gültig bis 2027-01-20 … 2027-02-05    |
| HSTS / HTTP/2  | keine Site setzt HSTS; keine Site nutzt `http2`                                                                                                                                                                                                                                                                                                 |
| Basic-Auth     | rankyhub.com und (laut Statuscode 401 von innen) takt nutzen Basic-Auth – **nicht** für uns                                                                                                                                                                                                                                                     |
| Dienste        | genius (Docker, 1,37 GiB RSS), takt-backend.service, mongod.service (127.0.0.1), pm2-root (pulsebot-ui, pulsebot-bot) – alle aktiv, keine fehlgeschlagenen Units                                                                                                                                                                                |
| Journal        | 56 MB, `SystemMaxUse=1G`, `MaxRetentionSec=7day`, komprimiert                                                                                                                                                                                                                                                                                   |
| Sonstiges      | unattended-upgrades aktiv (ohne Auto-Reboot-Eintrag); Werkzeuge rsync 3.2.7, zstd, sha256sum, curl, python3 vorhanden; UID/GID 10001 und Benutzer `orderflow` frei; `/opt/orderflow-binance`, `/etc/orderflow-binance`, `/var/lib/orderflow-binance`, `/var/www/orderflow-acme` existieren nicht; DNS `orderflow.rankyhub.com` → Server-Adresse |

## Entscheidungen

### Layout auf dem Server

```
/opt/orderflow-binance/            root, 0755
  compose.prod.yml                 diese Datei aus deploy/
  .env                             nur OF_RELEASE=<id> (kein Secret)
  bin/  restore-db.sh, orderflow-monitor
  sql/  roles.sql, post-restore.sql, verify-db.sql, harden-db.sql
  releases/<id>/                   je Release: web/, RELEASE, SHA256SUMS (Image-Tar nach load gelöscht)
  current -> releases/<id>         nginx-root = current/web; Umschalten atomar per mv -T
/etc/orderflow-binance/            root, 0700 – Secrets, je 0600
  db.env   POSTGRES_PASSWORD / OF_DB_PASSWORD (Admin- und Migrationsrolle of_admin)
  api.env  OF_API_DB_PASSWORD (Rolle of_api)
  healthcheck.env                  später: HC_PING_URL (Totmann), fehlt = aus
/var/lib/orderflow-binance/        root, 0700
  transfer/<dump>/                 Übergabe der Dumps (nur während des Transfers)
  (später data/raw, data/live für Importer/Recorder)
/var/www/orderflow-acme/           ACME-Webroot (wie genius/takt)
```

Docker-Projekt `orderflow-binance`, Container `orderflow-db`/`orderflow-api`, Netz
`orderflow-binance_net`, Volume `orderflow-binance_pgdata` – keine Überschneidung mit
`genius-live`. Systembenutzer `orderflow` (UID/GID 10001, nologin) reserviert die UID, mit der die
API im Container läuft (nicht 1000 = `ubuntu` auf dem Host).

**Erweiterbarkeit:** Importer und Recorder kommen als weitere Dienste in `compose.prod.yml` (gleiches
Image, das `apps/importer` bereits enthält) bzw. als systemd-Units, die die DB über
`127.0.0.1:54320` erreichen; Daten unter `/var/lib/orderflow-binance/data`. Nichts am Layout muss
dafür umgebaut werden.

### Datenbank (`compose.prod.yml`, Dienst `db`)

- Image exakt `timescale/timescaledb:2.31.2-pg17` **plus Index-Digest** (identisch mit dem Mac) –
  Restore setzt identische Postgres- und Timescale-Versionen voraus.
- Port nur `127.0.0.1:54320` (für Werkzeuge auf dem Host und SSH-Tunnel vom Mac); die API spricht
  die DB über das interne Netz an. Daten im benannten Volume.
- Speicher: `mem_limit 2g` (Page-Cache zählt mit), `shm_size 256mb`, `cpus 1.5`,
  `oom_score_adj 300` (bei globalem Speichermangel ohne Swap trifft der OOM-Killer zuerst uns, nicht
  genius/mongod). Begründung der Werte: ≈ 5,4 GB verfügbar, die Nachbarn wachsen (genius 1,4 GB);
  DB + API mit 2,6 GB Limit lassen ≈ 2,8 GB Reserve. Die DB (≈ 0,8 GB) passt ganz in
  `shared_buffers` + Cache. Mit P3 (Recorder, PulseBot/mongod gestoppt) auf 2,5 GB / 640 MB gemäß
  KONZEPT §2.4 anheben.
- Einstellungen: `shared_buffers=512MB`, `effective_cache_size=1280MB`, `work_mem=32MB` (die Rolle
  `of_api` bekommt per Migration 0010 16 MB), `maintenance_work_mem=256MB`,
  `autovacuum_max_workers=2` + `autovacuum_work_mem=64MB` (sonst bis 3 × 256 MB im 2-GB-Limit),
  `max_connections=30`,
  `max_parallel_workers_per_gather=1`, `max_parallel_workers=2`, `max_worker_processes=10`,
  `timescaledb.max_background_workers=4`, `timescaledb.telemetry_level=off` (+ `NO_TS_TUNE`,
  damit `timescaledb-tune` nichts in `postgresql.conf` schreibt), `random_page_cost=1.1`,
  `log_min_duration_statement=2000`. Healthcheck `pg_isready`, `restart: unless-stopped`, Logs per
  journald-Treiber (Rotation über die vorhandene journald-Konfiguration, `daemon.json` bleibt
  unberührt).

### Rollen und Migrationen

- `of_admin` = Superuser des Containers, Eigentümer und Migrationsrolle; `of_api` = nur lesend
  (Migration 0009, ohne Passwort im Repo). Passwörter erzeugt `install-server.sh` **auf dem
  Server** (`openssl rand`), nie übertragen, nie ausgegeben.
- **Migrationen aus einem Node-Container** (`compose run --rm ops …`, gleiches Image wie die API):
  der Server hat Node 20 für PulseBot, das Projekt braucht Node 24; ein zweites systemweites Node
  oder ein Upgrade würde pm2/PulseBot gefährden, ein SSH-Tunnel vom Mac koppelt jede Migration an
  den Mac. Das Image enthält genau die Migrationsdateien des Releases; `release.sh` prüft den Stand
  und wendet ausstehende Migrationen nur mit `--migrate` an.
- Passwort der API-Rolle: `release.sh` ruft bei jedem Release `api-role-password.ts` im
  ops-Container auf (liest `OF_API_DB_PASSWORD` aus `api.env`, idempotent).
- Härtung (`sql/harden-db.sql`, nach dem Transfer): `REVOKE CONNECT, TEMPORARY … FROM PUBLIC`,
  ausdrücklich `CONNECT, TEMPORARY` für `of_admin` und `CONNECT` für `of_api`.

### Datentransfer Mac → VPS (lokal getestet, siehe „Restore-Test")

`pg_dump -Fd -j 4 -Z zstd:3` über einen Wegwerf-Client-Container (gleiches Image → gleiche
pg_dump-Version) → SHA256SUMS → `rsync` → `sha256sum -c` → leere DB: Rollen (`roles.sql`) +
Rollen und Rolleneinstellungen der Quelle (`roles-source.sql` aus `sql/export-roles.sql`: `of_api`
und, ab Migration 0013, `of_recorder`; pg_dump sichert keine Rollen) →
`timescaledb_pre_restore()` → `pg_restore` **seriell** → `timescaledb_post_restore()` +
`GRANT CONNECT` (pg_dump ohne `--create` sichert keine Datenbankrechte) → `ANALYZE` →
Prüfbericht `verify-db.sql` auf beiden Seiten, **Pflichtvergleich** (Zeilenzahlen aller Tabellen,
Chunks und deren Columnstore-Zustand und Grenzen, Columnstore-Einstellungen, Policies/Jobs,
`data_day` vollständig, `day_digest_all` = gespeicherter Digest für jeden Tag, Inhalt aller kleinen
Tabellen, `schema_migrations`, Rolle `of_api` mit Attributen/Einstellungen/Rechten,
Default-Privilegien, Datenbankrechte). Erst danach Härtung und API-Start. Die VPS-Platte hält nie
die unkomprimierte Basistabelle.

**Restore-Test (2026-11-24/25, Mac, Wegwerf-Container `orderflow-db-restoretest`, 2 GB-Limit wie in
Produktion):**

| Messgröße                    | Wert                                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quelle                       | 167 Tage, DB 767 MB, `fp_1m` 77,2 Mio. Zeilen in 167 Chunks                                                                                                                              |
| `pg_dump -Fd -j 4 -Z zstd:3` | 2 s, 514 MB, 539 Dateien                                                                                                                                                                 |
| `pg_restore -j 2`            | **scheitert**: FK `compression_chunk_size_chunk_id_fkey` (Timescale-Katalog parallel in falscher Reihenfolge)                                                                            |
| `pg_restore` seriell         | 11 s, Exit 0                                                                                                                                                                             |
| `ANALYZE`                    | < 1 s                                                                                                                                                                                    |
| Ziel                         | DB 767 MB; alle 242 Columnstore-Chunks komprimiert angekommen (fp_1m 167/167, fp_1m_b10 25/25 …; die vier Jahres-Tabellen wie auf der Quelle unkomprimiert)                              |
| Prüfbericht                  | Quelle und Ziel **identisch** (ohne `info                                                                                                                                                | `-Zeilen): Zeilenzahlen, `data_day`-MD5, 167/167 Digests stimmen, 8 Policies, `schema_migrations`0001–0009 mit Prüfsummen,`of_api` (Attribute, Einstellungen, SELECT auf 20 Tabellen, 0 Schreibrechte, Default-ACL) |
| Prüfbericht-Laufzeit         | ≈ 3 min 25 s je Seite (count(*) über 77 Mio. Zeilen + Digests)                                                                                                                           |
| Nachtest                     | `convert_to_rowstore`/`convert_to_columnstore` eines Chunks, Digest danach gleich; `run_job(1000)` erfolgreich; API-Image (amd64) gegen die wiederhergestellte DB: `/api/v1/symbols` 200 |
| Hinweis                      | Die Telemetrie-/Statistik-Jobs (ID < 1000) legt jede Instanz selbst an; sie werden nicht verglichen                                                                                      |

Erwartet auf dem VPS: Upload von 514 MB (Dauer je nach Leitung), Restore ≈ 15–30 s, Prüfbericht
≈ 4–6 min (2 vCPU). Spitzenbedarf Platte ≈ 1,3 GB.

### API (Container statt systemd-Unit)

Node 24 fehlt auf dem Server (s. o.), daher Container aus `deploy/api.Dockerfile`
(`node:24.22.3-bookworm-slim`, nur Produktionsabhängigkeiten, Allowlist-`.dockerignore`, kein
`.env` im Image – `build-release.sh` prüft das), gebaut auf dem Mac für linux/amd64 und per
`docker save`/`docker load` übertragen (≈ 83 MB gzip; der Server baut nichts und zieht nur das
Timescale-Image). Betrieb: Port `127.0.0.1:8780`, `env_file` `/etc/orderflow-binance/api.env`
(0600), `restart: unless-stopped`, `mem_limit 600m`, `cpus 1.0`, `read_only`, `cap_drop ALL`,
`no-new-privileges`, `init`, UID 10001, `oom_score_adj 500`, Logs → journald, Healthcheck auf dem
Loopback-Listener der API im Container (`127.0.0.1:8781/health`, nicht veröffentlicht). Über den
Docker-Proxy sieht die API als Quelle das Bridge-Gateway, nicht 127.0.0.1 – Health deshalb nie vom
Host aus. Keep-Alive der API (65 s) > `keepalive_timeout` des nginx-Upstreams (60 s).

### Web

Bundle auf dem Mac gebaut (`npm run build -w @orderflow/web`), als `releases/<id>/web` übertragen;
`current` zeigt atomar auf das aktive Release (gemeinsam mit dem API-Image derselben ID, weil Web
und API einen Vertrag teilen). Rollback = `release.sh --rollback` (vorige ID, Image und Web).

### nginx

Eine neue Site-Datei `sites-available/orderflow.rankyhub.com` (Symlink
`sites-enabled/zz-orderflow.rankyhub.com`), Zonen in `conf.d/orderflow-binance.conf` (nur
`limit_req_zone`/`limit_conn_zone`, kein server-Block), Header in
`snippets/orderflow-binance-headers.conf`, gemeinsame `/api/`-Proxy-Einstellungen in
`snippets/orderflow-binance-proxy.conf`. Keine vorhandene Datei wird verändert.

- Statisch: `/assets/*` `public, max-age=31536000, immutable`; `/index.html` und SPA-Fallback
  `no-cache`; versteckte Dateien 404; nur GET/HEAD/OPTIONS (sonst 405); Auslieferung an der
  Domain-Wurzel (das Bundle nutzt absolute Pfade).
- `/api/` → Upstream `127.0.0.1:8780` mit Keep-Alive (60 s), `X-Real-IP`/`X-Forwarded-For`
  (überschrieben, nicht angehängt)/`X-Forwarded-Proto`, Timeouts connect 5 s, read/send 35 s;
  ETag/Cache-Control/Content-Encoding der API unverändert, **kein** nginx-Cache;
  `X-Source`, `X-Rows-Estimate`, `Server-Timing` werden zusätzlich ausgeblendet;
  `/api/v1/health` → 404 (die API liefert dort nur noch `{status}`, gesperrt bleibt es trotzdem).
- `/api/v1/quality` eigene Zone `orderflow_quality` (1 r/s, Burst 5 je IP): ohne Server-Cache und
  Zusammenfassen belegt eine Anfrage bis 5 s einen der 4 Limiter-Plätze der API; die Web-App ruft
  es noch nicht auf.
- Rate-Limit je IP: `rate=30r/s` (conf.d, Stellschraube 1) + `burst=90 nodelay` (Site,
  Stellschraube 2), `limit_conn 32`, Status 429; nginx-eigene 429/502/503/504 als kleines JSON mit
  `Retry-After`, ohne Versionsangabe (`server_tokens off` für diesen Server, global nicht gesetzt).
  Lokal getestet (nginx 1.18): 60 Anfragen über 6 Verbindungen → 60 × 200 (bei den früheren
  Werten 10 r/s / Burst 40: 42 × 200, 18 × 429); 429-Antwort `{"error":"zu viele Anfragen"}` mit
  `Retry-After: 1`; API gestoppt → 502 als JSON mit `Retry-After: 5`, Header `Server: nginx` ohne
  Version. Werte nach den Messungen des Web-Autors nachstellen.
- gzip für CSS/JS/JSON/`application/octet-stream`/SVG (die API komprimiert selbst; nginx
  komprimiert nur, was ohne Content-Encoding ankommt). Kein Brotli (Modul fehlt).
- Sicherheits-Header: `X-Content-Type-Options`, `X-Frame-Options DENY`, `Referrer-Policy`,
  `Permissions-Policy`, `Cross-Origin-Opener-Policy same-origin`, CSP (eine Zeile im Snippet;
  endgültiger Wert aus dem README-Abschnitt Web übernehmen). **Kein HSTS** (keine Nachbar-Site
  nutzt es). **Kein HTTP/2**, obwohl empfohlen: in nginx 1.18 gilt `http2` je Listen-Socket und
  würde genius/rankyhub/takt mit umstellen – Entscheidung des Nutzers.
- TLS wie genius/takt: certbot **webroot** mit dem vorhandenen Konto; Deploy-Hook (nginx -t +
  reload) nur in der eigenen Renewal-Datei; Erneuerung über den vorhandenen `certbot.timer`.
- Kein `default_server`. Standardserver je Socket ist der erste in Include-Reihenfolge; genius
  lauscht auf allen vier Sockets (80, [::]:80, 443, [::]:443, Survey 2026-11-25) und bleibt
  überall Standard. Der Symlink `zz-orderflow.rankyhub.com` sortiert zusätzlich immer zuletzt,
  unsere listen-Zeilen spiegeln die der Nachbarn (kein neuer Socket). Lokal mit Stub-Nachbarn
  (identische listen-Zeilen) für IPv4 und IPv6 geprüft: unbekannter Host → genius.
- Let's Encrypt: zwei Konten (Produktion + Staging); alle drei Renewal-Dateien nutzen dasselbe
  Produktionskonto → `certonly --account <id>` (aus den Renewal-Dateien gelesen). Erneuerung
  testen nur mit `certbot renew --dry-run --cert-name orderflow.rankyhub.com`.
- Lokal geprüft: `nginx -t` mit `nginx:1.18.0` (Server-Version) für Site und Bootstrap-Site;
  Funktionstest gegen API-Image + wiederhergestellte DB (Redirect 308, Header, Cache-Control,
  ETag/304-Durchreichung, gzip der API mit starkem ETag, Health 404, POST 405, Rate-Limit).

### Monitoring (minimal)

`orderflow-monitor.timer` (alle 5 min) → `bin/orderflow-monitor`: Container-Health von DB und API,
Detail-Health der API, `/api/v1/symbols` über nginx, freie Platte ≥ 10 GB, MemAvailable ≥ 500 MB,
NTP. Ergebnis als Journal-Zeile, Exit 1 → Unit „failed". Externer Totmann (healthchecks.io, Ping
nur bei „healthy", sonst `/fail` mit Gründen) ist eingebaut, aber **aus**, bis der Nutzer eine URL
in `/etc/orderflow-binance/healthcheck.env` (`HC_PING_URL=…`, 0600) hinterlegt.

### Backups

Auf dem Server ist fast nichts zu sichern: die Daten sind aus dem Mac jederzeit neu übertragbar
(`transfer-db.sh --replace`), Releases neu baubar. Sichernswert sind nur die Secrets in
`/etc/orderflow-binance/` – und auch die sind ersetzbar (neu erzeugen, Rollenpasswörter neu
setzen). Kein Backup-Job in dieser Stufe. Das ändert sich mit dem Live-Recorder (P3): dann entstehen
Daten nur auf dem VPS (Spool, provisorische Minuten) und brauchen eine eigene Sicherung.

## Abgleich mit dem Stand der Anwendung (2026-11-25, nach den API-Fixes)

- API-Variablen in `compose.prod.yml` gegen `apps/api/src/config.ts`/`apps/api/README.md` geprüft:
  `OF_API_HOST/PORT/CORS_ORIGINS/DB_POOL/CACHE_MB/KEEPALIVE_TIMEOUT_MS/REQUEST_TIMEOUT_MS/
CONNECTION_TIMEOUT_MS/ADMIN_PORT/DIAG_HEADERS/NONFINAL_TTL_MS/MAX_CONNECTIONS/MAX_QUEUE`,
  `OF_LOG_LEVEL=warn` (keine Zeile je Anfrage im gemeinsamen Journal). Status-Listener bindet
  immer 127.0.0.1:8781 im Container → Healthcheck per `node -e fetch` im Container.
- `api-role-password.ts` (berechnet jetzt den SCRAM-Verifier im Client): Aufruf unverändert.
- Migration 0010 (`work_mem=16MB`, kein SELECT auf `raw_file`, `raw_day`, `schema_migrations`,
  `verify_run`): Tabellenrechte kommen mit dem Dump, die Rolleneinstellung über
  `roles-source.sql`; der Prüfbericht vergleicht beides (`grant|of_api|tables=20|select=16`).
- `harden-db.sql` = Anweisungen aus `apps/api/README.md` („Rechte auf Datenbankebene"), inkl.
  `postgres`/`template1`; `transfer-db.sh` prüft das Ergebnis.
- CSP im Snippet = Wert im README-Abschnitt Web.
- Cache: finale Kacheln `max-age=604800` u. a. kommen unverändert von der API; nginx setzt keine
  API-Cache-Header und cacht nicht.

## Stand 2026-11-25 (zweiter Abgleich)

- Daten: BTCUSDT + ETHUSDT je 167 Tage, Migration 0012 (0011 Recorder-Tabellen `ingest_status`,
  `live_kline_check`, `recorder_quality`, `data_day.live_until/live_minutes`; 0012 entzieht
  `of_api` SELECT darauf). `verify-db.sql` erfasst neue Tabellen und Spalten generisch (Zeilenzahl,
  Inhalt, `data_day` vollständig); `grant|of_api|tables=23|select=16|write=0` auf beiden Seiten.
- Ein leerer, nicht komprimierter `fp_1m`-Chunk 2026-11-24…25 (Rest von Recorder-Testdaten) wird
  auf beiden Seiten gleich gezählt (`chunks|fp_1m|total=168|columnstore=167`). Unschädlich; vor
  dem Dump gelöscht wäre der Stand sauberer (die Policy versucht ihn sonst ab 2026-11-28 zu
  komprimieren) – Entscheidung beim Eigentümer der Mac-DB.
- Trockenlauf (Mac, 2-GB-Limit): Dump im Snapshot 3 s, 848 MB / 543 Dateien; `pg_restore` 22 s;
  ANALYZE 2 s; Prüfbericht 5 min 25 s je Seite (parallel); Berichte identisch (388 Zeilen,
  334/334 Digests); Härtung geprüft. Ziel-DB 1 199 MB (Quelle 1 255 MB inkl. Bloat).
- `build-release.sh` baut aus `git archive <commit>` (Standard HEAD) in einem eigenen Verzeichnis
  mit `npm ci`; uncommittete Änderungen im Arbeitsbaum gehören nie zum Release, RELEASE nennt den
  Commit. Image 352 MB (81 MB gzip), Recorder-Quellen nicht im Image (nur sein Manifest für
  `npm ci`), Prozess im Container nur die API.
- Funktionstest Release-Image + restaurierte DB + nginx 1.18 mit Stub-Nachbarn: beide Symbole,
  Bars (auch `stats=1`), Kacheln 1m/15m bei feinster und mittlerer Zeilengröße, Profil und
  Tagesprofile → 200, gzip, `public, max-age=604800` für unveränderliche Tage, 304 mit
  If-None-Match; Health 404; keine Diagnose-Header; Quality-Burst 6 × 200 / 6 × 429 (JSON,
  `Retry-After: 1`); 96 gemischte Anfragen über 6 Verbindungen alle 200; API-Log bei `warn` leer;
  API 151 MiB.

## Transfer-Werkzeuge ab Migration 0013/0014 (lokal geprüft, noch nicht auf dem Server)

- `sql/export-roles.sql` (Quelle, nur lesend) erzeugt `roles-source.sql`: Anlage/Angleichung von
  `of_api` und `of_recorder` (falls auf der Quelle vorhanden; Rollen sind clusterweit, auf dem
  Mac existiert `of_recorder` schon, auch wenn `orderflow` noch bei 0012 ist), deren
  Rolleneinstellungen und die Datenbankrechte von `of_api`, `of_recorder` und PUBLIC auf
  `orderflow` (pg_dump ohne `--create` sichert sie nicht). Keine Passwörter. Bricht ab, wenn eine
  Anwendungsrolle auf der Quelle erhöhte Rechte hat.
- `verify-db.sql` vergleicht für beide Rollen: Attribute und Einstellungen, Datenbank-/Schemarechte
  (inkl. TEMPORARY), Tabellenrechte je Art samt Liste der beschreibbaren Tabellen, ausführbare
  Projektfunktionen und je Projektfunktion Eigentümer, SECURITY DEFINER, `search_path` und ACL
  (`of_recompress_chunk` aus 0014), Default-ACLs; Policy-Konfiguration (`recompress: false`) steht
  in den `job|`-Zeilen.
- `harden-db.sql`: `of_recorder` behält nur sein ausdrückliches CONNECT (aus 0013 bzw. vom
  Transfer), nie TEMPORARY; die Härtungsprüfung gilt für beide Rollen.
- Trockenläufe (Wegwerf-Container, 2-GB-Limit):
  - A, Quelle Mac-DB bei 0012 (`of_recorder` existiert clusterweit ohne Rechte): Berichte identisch
    (396 Zeilen), Härtung OK, `of_recorder` ohne CONNECT.
  - Migration 0013 + 0014 auf dem gehärteten Ziel von A (= späteres `release.sh --migrate`):
    `of_recorder` bekommt CONNECT nur auf `orderflow`, kein TEMPORARY.
  - B, Quelle = dieses Ziel bei 0014 (gehärtet): Dump 5 s / 848 MB, `pg_restore` 18 s, Berichte
    identisch (400 Zeilen) inkl. `of_recorder` (CONNECT, kein TEMP, SELECT auf 23 Tabellen,
    Schreibrechte auf 21, `of_recompress_chunk` SECURITY DEFINER nur für ihn ausführbar,
    Default-ACL `of_recorder=r`, Policies `recompress: false`); Härtung OK. Der erste Lauf zeigte,
    dass eine gehärtete Quelle die PUBLIC-Rechte mitliefern muss (behoben). Gegenprobe: der
    Export einer ungehärteten Quelle ergibt auf einer frischen Datenbank exakt deren datacl.

## Rollout 2026-11-25 (ausgeführt)

Release `20261125T084611Z-ba55a900e2` (Commit ba55a90), DB-Transfer mit identischen Prüfberichten
(388 Zeilen, 334/334 Digests), Zertifikat Let's Encrypt bis 2027-02-23 (Renewal-Probelauf mit
`--cert-name` erfolgreich), Monitor-Timer aktiv, Nachbarn vor/nach identisch (82 Prüfzeilen).
Screenshots der öffentlichen Seite: `docs-screenshots/public-btcusdt-{1m,15m}.png`.

Messungen (VPS, Abfrage auf dem Server über 127.0.0.1:8780, erster Abruf = Cache-Fehlgriff der API
gegen die DB; Wiederholung = Antwort-Cache der API):

| Anfrage (BTC / ETH)                                       | erster Abruf (Server) | Wiederholung (Server) | Budget kalt / warm |
| --------------------------------------------------------- | --------------------- | --------------------- | ------------------ |
| Bars 1m (1 Tag), 1h (30 Tage)                             | 17–62 ms              | 1,7–2,6 ms            | 300 / 100 ms       |
| Bars 1h 30 Tage `stats=1`                                 | 116–130 ms            | ≈ 2 ms                | 300 / 100 ms       |
| Footprint 1m/15m/4h, automatische und feinste Zeilengröße | 34–141 ms             | 1,5–5,1 ms            | 800 / 250 ms       |
| Profil 7 Tage / Tagesprofile 30 Tage                      | 15–31 ms              | 1,2–2,3 ms            | –                  |

Netz vom Mac: TCP ≈ 19 ms (1 RTT), TLS fertig nach ≈ 39 ms; Erstabruf von außen 71–213 ms
(= neue Verbindung + Server), Wiederholung auf bestehender Verbindung 18–23 ms (≈ RTT + 2 ms).
20 gleichzeitige gemischte Erstabrufe: alle 200, langsamster 478 ms (Pool 4 → Warteschlange),
Wanduhr 0,54 s; warm 68–151 ms. Speicher: DB 1,2 GiB / 2 GiB, API 165 MiB / 600 MiB;
MemAvailable 5,43 → 4,67 GB, Platte 80 → 75 GB frei.

## Offen

- HTTP/2 (betrifft alle Sites auf 443) – Entscheidung des Nutzers.
- Healthchecks.io-URL – vom Nutzer; bis dahin alarmiert niemand.
- Rate-Limit nach den gemessenen Raten des Web-Autors nachstellen (Stellschrauben 1/2).
- Pflichtvergleich: Quellbericht und Dump lesen denselben exportierten Snapshot; auf dem Ziel sind
  die Policies während des Berichts angehalten (ein früherer Lauf hatte eine echte Änderung an der
  Mac-DB zwischen Dump und Bericht als Abweichung gemeldet – der Vergleich greift).
