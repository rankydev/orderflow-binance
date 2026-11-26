# @orderflow/api – lesende HTTP-API

Verträge: [`docs/TILE-FORMAT.md`](../../docs/TILE-FORMAT.md) (`/symbols`, `/bars`, `/footprint`) und
[`docs/PROFILE-API.md`](../../docs/PROFILE-API.md) (`/profile`, `/profiles/daily`, `/quality`),
[`docs/BIGTRADES-API.md`](../../docs/BIGTRADES-API.md) (`/bigtrades`). Nur lesende
Endpunkte, Datenbankrolle `of_api` (nur SELECT).

## Starten (lokal)

```sh
source ~/.nvm/nvm.sh && nvm use
npm run db:migrate                      # legt of_api an (0009) und schärft sie nach (0010)
# OF_API_DB_PASSWORD (16–128 Zeichen A–Z a–z 0–9 _ -) in .env eintragen, dann:
npm run role:password -w @orderflow/api # sendet nur den SCRAM-Verifier, nie den Klartext
npm start -w @orderflow/api             # http://127.0.0.1:8780, Status-Listener 127.0.0.1:8781
```

Web-App gegen die API (zweiter Vite-Server): `cd apps/web && VITE_API_BASE=http://127.0.0.1:8780 npx vite --port
5174 --strictPort`. Im Betrieb liegt die API hinter nginx unter `/api/v1` auf demselben Ursprung (kein CORS).

Tests: `npm test` (Unit), `npm run test:db` (Integration gegen eine eigene Datenbank `<OF_DB_NAME>_test_api`, damit parallel laufende
Suiten anderer Pakete auf `<OF_DB_NAME>_test` sie nicht stören). Benchmark:
`npm run bench -w @orderflow/api`. Browser-Prüfung: `apps/api/bench/browser-check.ts`.

## Ports und Health

| Listener                                                          | Bindung             | Pfade                                                                                                          |
| ----------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| öffentlich (`OF_API_HOST`:`OF_API_PORT`, Standard 127.0.0.1:8780) | hinter nginx        | `/api/v1/*`; `/api/v1/health` nur `{ "status": "ok" \| "unavailable" }` (200/503), keine Interna               |
| Status (`OF_API_ADMIN_PORT`, Standard 8781, `0` = aus)            | **immer** 127.0.0.1 | `/health`: Gründe, Katalogalter und -fehler, Symbole, Cache, Limiter, Speicher (für health-ping, KONZEPT §2.5) |

## Einstellungen (Umgebung, Standardwerte)

`OF_API_HOST=127.0.0.1`, `OF_API_PORT=8780`, `OF_API_ADMIN_PORT=8781`, `OF_API_CORS_ORIGINS=loopback`
(`*` oder Liste), `OF_API_DB_POOL=4`, `OF_API_MAX_QUEUE=64`, `OF_API_QUEUE_TIMEOUT_MS=10000`,
`OF_API_STATEMENT_TIMEOUT_MS=5000`, `OF_API_CATALOG_STATEMENT_TIMEOUT_MS=30000` (eigener Katalog-Pool: Statistik bis 1 Jahr bar_1m je Abfrage; ein wiederholt scheiternder Start wird als Fehler geloggt und unter `/health` mit Grund und Zahl der Versuche gemeldet), `OF_API_LOCK_TIMEOUT_MS=1000`, `OF_API_LOCK_RETRIES=3`, `OF_API_CACHE_MB=200`,
`OF_API_NONFINAL_TTL_MS=10000`, `OF_API_POLL_MS=1000`, `OF_API_MAX_SOURCE_ROWS=1500000` (Profile, `/bars`), `OF_API_MAX_TILE_SOURCE_ROWS=300000` (Angebot und
Auslieferung der Footprint-Kacheln), `OF_API_MAX_CELLS=60000`
(nur Profile), `OF_API_CONNECTION_TIMEOUT_MS=30000`, `OF_API_REQUEST_TIMEOUT_MS=30000`,
`OF_API_KEEPALIVE_TIMEOUT_MS=65000`, `OF_API_MAX_REQUESTS_PER_SOCKET=1000`, `OF_API_MAX_CONNECTIONS=1024`,
`OF_API_DIAG_HEADERS=0` (1 = `X-Source`, `X-Rows-Estimate`, `Server-Timing`), `OF_API_STALE_AFTER_MS=30000`
(Katalog länger ausgefallen → 503 statt 304/Cache-Treffer auf altem Stand).

`OF_API_KEEPALIVE_TIMEOUT_MS` liegt bewusst **über** dem `keepalive_timeout` des nginx-`upstream`-Blocks (Standard
60 s): schließt die API eine Leerlaufverbindung früher als nginx, kann nginx sie gerade wiederverwenden und
antwortet mit 502. Wird nginx anders eingestellt, diesen Wert entsprechend darüber setzen.

`OF_API_RECORDER_EVENTS_URL` (Standard leer = aus): SSE-Feed des Recorders, z. B.
`http://recorder:7701/events`; jedes `event: minute` stößt sofort eine Katalog-Aktualisierung an (sonst bis zu
`OF_API_POLL_MS` später). Fällt der Feed aus, verbindet sich die API mit Backoff (1–30 s) neu; die Abfrage läuft
unabhängig davon weiter; der Backoff fällt erst nach einem empfangenen Ereignis bzw. 30 s Verbindung auf 1 s zurück. Kommentarzeilen (`: ok`, Keepalive) werden ignoriert, der Client braucht sie nicht. Zustand unter `/health` des Status-Listeners (`recorderEvents`).

Startzeit (`node --env-file=.env apps/api/bench/catalog-start.ts`, nur lesend): Der Katalog liest beim Start
`symbol`, `data_day` und je Symbol die Bar-Tabellen der ganzen Historie in einem Lauf je ≤ 366 Tage – 2 + 4 ·
Symbole Abfragen (bis 1 Jahr je Symbol), nie eine Footprint-Tabelle. Mac, 2 × 169 Tage: 0,28–0,32 s, 10 Abfragen,
≈ 8 MB Seiten je Symbol (bar_1m ≈ 45 KB je Symbol-Tag). Vorher (exakte Zählung aller Footprint-Tabellen, Läufe à
31 Tage): 1,4 s warm und 62 Abfragen auf dem Mac, ≈ 2,7 GB Seiten je Symbol – auf dem VPS (DB-Container 2 GB
inkl. Page-Cache, 512 MB shared_buffers) also überwiegend Plattenlesen: 63 s bis „bereit" beim Release
2026-11-25. Der Test „Katalogstart" in `test/api.int.test.ts` hält die Zahl der Abfragen und den Verzicht auf
Footprint-Tabellen fest. Bis der Katalog geladen ist, antworten die Datenendpunkte mit 503 + `Retry-After`.

## Datenbank: Rechte auf Datenbankebene (für das Deployment)

Die Migrationen laufen innerhalb einer Datenbank und können `CONNECT`/`TEMPORARY` der Rolle `PUBLIC` nicht für
alle Datenbanken des Clusters entziehen. Standardmäßig darf daher jede Rolle (auch `of_api`) sich mit jeder
Datenbank verbinden und temporäre Tabellen anlegen. Einmalig als Superuser (im Container: `POSTGRES_USER`) auf dem
Server ausführen, nach `npm run db:migrate`:

```sql
-- Anwendungsdatenbank: nur ausdrücklich berechtigte Rollen
REVOKE CONNECT, TEMPORARY ON DATABASE orderflow FROM PUBLIC;
GRANT  CONNECT, TEMPORARY ON DATABASE orderflow TO of_admin;   -- Migrationen/Importer (ggf. weitere Schreibrollen)
GRANT  CONNECT            ON DATABASE orderflow TO of_api;     -- API: nur verbinden, keine TEMP-Tabellen

-- Wartungsdatenbanken: keine Verbindung für Anwendungsrollen
REVOKE CONNECT, TEMPORARY ON DATABASE postgres  FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;   -- CREATE DATABASE (als Superuser) funktioniert weiter

-- Prüfung: of_api darf sich nur mit orderflow verbinden und dort nichts anlegen
SELECT datname, has_database_privilege('of_api', datname, 'CONNECT')   AS connect,
               has_database_privilege('of_api', datname, 'TEMPORARY') AS temp
  FROM pg_database ORDER BY datname;
SELECT rolname, rolconfig FROM pg_roles WHERE rolname = 'of_api';
-- erwartet: work_mem=16MB, default_transaction_read_only=on, statement_timeout=15s, lock_timeout=5s,
--           idle_in_transaction_session_timeout=60s
```

Gibt es auf dem Server weitere Datenbanken mit `PUBLIC`-Rechten (z. B. eine Testdatenbank `orderflow_test`),
dort ebenfalls `REVOKE CONNECT, TEMPORARY ON DATABASE <name> FROM PUBLIC;`. Läuft ein Importer mit einer eigenen
Rolle (`of_importer`, KONZEPT §2.4), braucht diese `GRANT CONNECT, TEMPORARY ON DATABASE orderflow TO of_importer;`.

Passwort der API-Rolle setzen: `npm run role:password -w @orderflow/api` (aus `OF_API_DB_PASSWORD`, als Admin-Rolle
verbunden). Das Werkzeug berechnet den SCRAM-SHA-256-Verifier im Client; der Server sieht den Klartext nie, auch
nicht im Log bei `log_statement` oder in einer Fehlermeldung.

## Neue Tabellen und die API-Rolle (für Migrationsautoren)

Migration 0009 vergibt **Standardrechte**: jede Tabelle, die eine spätere Migration (als Migrationsrolle) im
Schema `public` anlegt, ist automatisch für `of_api` lesbar. Wer eine Tabelle anlegt, entscheidet bewusst:

- Die API soll sie lesen → in `API_READABLE` in `apps/api/test/api.int.test.ts` eintragen.
- Die API soll sie nicht lesen (Betriebs-, Manifest- oder Rohdaten) → in derselben Migration
  `REVOKE SELECT ON <tabelle> FROM of_api;` (wie 0010 für `raw_file`, `raw_day`, `schema_migrations`,
  `verify_run`).

Der Integrationstest „of_api liest genau die freigegebenen Tabellen" schlägt fehl, solange eine neue Tabelle in
keiner der beiden Listen steht. Die Integrationstests selbst laufen mit einer eigenen Rolle `of_api_test`, die in
der Testdatenbank genau die Rechte und Rolleneinstellungen von `of_api` gespiegelt bekommt; sie ändern nie das
Passwort der clusterweiten Rolle `of_api`.
