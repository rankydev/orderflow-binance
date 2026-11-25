#!/usr/bin/env bash
# Spielt einen pg_dump (Verzeichnisformat) in die laufende Timescale-Instanz ein und schreibt den
# Prüfbericht (deploy/sql/verify-db.sql) nach stdout. Läuft auf dem VPS (installiert unter
# /opt/orderflow-binance/bin/, aufgerufen von deploy/transfer-db.sh); lokal gegen einen
# Wegwerf-Container testbar. Alle DB-Befehle per `docker exec` im DB-Container (lokaler Socket).
#
#   restore-db.sh --container orderflow-db --dump /transfer/<name> --sql-dir <dir> [--replace]
#
# Verfahren (am Restore-Test 2026-11-24 bestätigt, TimescaleDB 2.31.2/PG 17):
#   Rollen anlegen → CREATE EXTENSION → timescaledb_pre_restore() → pg_restore OHNE -j →
#   post-restore.sql (timescaledb_post_restore(), GRANT CONNECT) → ANALYZE → Prüfbericht.
# pg_restore -j N scheitert reproduzierbar: Fremdschlüssel im Timescale-Katalog
# (compression_chunk_size → chunk) werden parallel in falscher Reihenfolge befüllt.
# Columnstore-Chunks kommen komprimiert an (Dump enthält die komprimierten internen Tabellen).
set -euo pipefail

C=orderflow-db
DUMP=
SQL_DIR=
REPLACE=0
DB=orderflow
ADMIN=of_admin
EXPECT_TS=2.31.2
while [ $# -gt 0 ]; do
  case "$1" in
    --container) C="$2"; shift 2 ;;
    --dump) DUMP="$2"; shift 2 ;;
    --sql-dir) SQL_DIR="$2"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --expect-timescaledb) EXPECT_TS="$2"; shift 2 ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$DUMP" ] && [ -d "$SQL_DIR" ] || { echo "Verwendung: $0 --dump /transfer/<name> --sql-dir <dir> [--container C] [--replace]" >&2; exit 2; }

say() { printf '[restore %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
psql_c() { docker exec -i "$C" psql -X -q -At -v ON_ERROR_STOP=1 -U "$ADMIN" "$@"; }

docker exec "$C" pg_isready -q -U "$ADMIN" -d "$DB" || { say "Datenbank in Container $C nicht bereit"; exit 1; }
docker exec "$C" test -f "$DUMP/toc.dat" || { say "kein Dump unter $DUMP (toc.dat fehlt) im Container"; exit 1; }

tables=$(psql_c -d "$DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')")
if [ "$tables" != 0 ]; then
  if [ "$REPLACE" != 1 ]; then
    say "Zieldatenbank $DB ist nicht leer ($tables Tabellen) – Abbruch (ersetzen nur mit --replace)"
    exit 1
  fi
  if [ "$(docker ps -q -f name='^orderflow-api$')" != "" ]; then
    say "--replace verlangt eine gestoppte API (Container orderflow-api läuft)"
    exit 1
  fi
  if [ "$(docker ps -q -f name='^orderflow-recorder$')" != "" ]; then
    say "--replace verlangt einen gestoppten Recorder (deploy/recorder.sh stop) – sonst schriebe er in die neue Datenbank"
    exit 1
  fi
  say "ersetze Datenbank $DB (DROP/CREATE)"
  psql_c -d postgres -c "DROP DATABASE $DB WITH (FORCE)" -c "CREATE DATABASE $DB OWNER $ADMIN"
fi

say "Rollen (deploy/sql/roles.sql)"
psql_c -d "$DB" < "$SQL_DIR/roles.sql"
# Rolleneinstellungen sind clusterweit und nicht im Dump: transfer-db.sh legt die der Quelle als
# roles-source.sql in den Dump (ALTER ROLE … RESET ALL + SET wie auf dem Mac, z. B. work_mem aus
# späteren Migrationen); verify-db.sql vergleicht danach rolconfig.
if docker exec "$C" test -f "$DUMP/roles-source.sql"; then
  say "Rolleneinstellungen der Quelle (roles-source.sql)"
  docker exec "$C" psql -X -q -v ON_ERROR_STOP=1 -U "$ADMIN" -d "$DB" -f "$DUMP/roles-source.sql"
fi
psql_c -d "$DB" -c "CREATE EXTENSION IF NOT EXISTS timescaledb" 2>/dev/null
v=$(psql_c -d "$DB" -c "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
[ "$v" = "$EXPECT_TS" ] || { say "TimescaleDB $v ≠ erwartet $EXPECT_TS – Abbruch"; exit 1; }

say "timescaledb_pre_restore()"
psql_c -d "$DB" -c "SELECT timescaledb_pre_restore()" >/dev/null
t0=$(date +%s)
say "pg_restore (seriell)"
if ! docker exec "$C" pg_restore -U "$ADMIN" -d "$DB" --exit-on-error "$DUMP"; then
  say "pg_restore fehlgeschlagen – Restore-Modus wird beendet, Datenbank ist unvollständig"
  psql_c -d "$DB" -c "SELECT timescaledb_post_restore()" >/dev/null || true
  exit 1
fi
say "pg_restore fertig in $(( $(date +%s) - t0 )) s"
# Columnstore-Policies bis nach dem Prüfbericht anhalten (noch im Restore-Modus, also bevor der
# Scheduler startet): ein Job zwischen Restore und Bericht änderte sonst chunks|-Zeilen.
paused=$(psql_c -d "$DB" -c "SELECT string_agg(id::text, ' ' ORDER BY id) FROM _timescaledb_config.bgw_job WHERE id >= 1000 AND scheduled")
# Trap VOR der Schleife: scheitert ein alter_job mittendrin, werden die bereits angehaltenen Jobs
# beim Abbruch wieder eingeschaltet (|| true: jeden Job versuchen).
resume() { for j in $paused; do psql_c -d "$DB" -c "SELECT alter_job($j, scheduled => true)" >/dev/null || true; done; }
trap resume EXIT
for j in $paused; do psql_c -d "$DB" -c "SELECT alter_job($j, scheduled => false)" >/dev/null; done
say "Policies angehalten: ${paused:-keine}"
psql_c -d "$DB" < "$SQL_DIR/post-restore.sql" >/dev/null
say "ANALYZE"
docker exec "$C" vacuumdb -U "$ADMIN" -d "$DB" --analyze-only -q
say "Prüfbericht (≈ 3–4 min)"
psql_c -d "$DB" < "$SQL_DIR/verify-db.sql"
resume
trap - EXIT
say "Policies wieder aktiv: ${paused:-keine}"
# Planungszustand der Anwendungs-Jobs nach dem Wiederanlauf (Quelle: transfer-db.sh, gleiche Abfrage)
psql_c -d "$DB" -c "SELECT 'jobsched|' || job_id || '|' || scheduled FROM timescaledb_information.jobs WHERE job_id >= 1000 ORDER BY job_id"
say "fertig"
