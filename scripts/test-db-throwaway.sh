#!/usr/bin/env bash
# DB-Integrationstests gegen einen Wegwerf-Container (eigener Port, eigenes Passwort, danach
# samt Volume entfernt). Berührt weder die Entwicklungs-DB noch .env: die OF_DB_*-Variablen der
# Umgebung haben Vorrang vor .env (node --env-file-if-exists).
#   scripts/test-db-throwaway.sh            # npm run test:db
#   scripts/test-db-throwaway.sh <befehl…>  # beliebiger Befehl mit denselben OF_DB_*-Variablen
set -euo pipefail
IMAGE=timescale/timescaledb:2.31.2-pg17 # wie docker-compose.yml
NAME="ofb-test-$$-$RANDOM"
PW="t$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --name "$NAME" -e POSTGRES_USER=of_admin -e POSTGRES_PASSWORD="$PW" \
  -e POSTGRES_DB=orderflow -e TZ=UTC -e PGTZ=UTC -p 127.0.0.1::5432 --shm-size 512m "$IMAGE" \
  postgres -c timezone=UTC -c max_connections=60 -c timescaledb.telemetry_level=off >/dev/null
PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')
ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U of_admin -d orderflow -h 127.0.0.1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "Wegwerf-DB nicht bereit" >&2; exit 1; }
sleep 2 # Initialisierung startet den Server einmal neu
echo "Wegwerf-DB $NAME auf 127.0.0.1:$PORT"
export OF_DB_HOST=127.0.0.1 OF_DB_PORT="$PORT" OF_DB_USER=of_admin OF_DB_PASSWORD="$PW" OF_DB_NAME=orderflow
# Name des Containers für Tests, die psql per `docker exec` aufrufen (Deploy-Skripte, z. B.
# apps/importer/test/transfer-bigtrades.int.test.ts); ohne diese Variable überspringen sie sich.
export OF_TEST_DB_CONTAINER="$NAME"
if [ $# -gt 0 ]; then "$@"; else npm run test:db; fi
