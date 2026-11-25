#!/usr/bin/env bash
# Offene Chunks im Columnstore auf dem VPS auflisten (nur lesend; deploy/sql/hot-chunks.sql).
# Installiert unter /opt/orderflow-binance/bin/ (install-server.sh).
#
#   hot-chunks.sh                  Liste + Anzahl, Exit 0
#   hot-chunks.sh --require-zero   Exit 1, wenn es offene komprimierte Chunks gibt
#                                  (nach repair-open-chunks und vor dem Start des Recorders)
# Einzeiler ohne Installation (auf dem Server):
#   docker exec -i orderflow-db psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow \
#     < /opt/orderflow-binance/sql/hot-chunks.sql
set -euo pipefail
SQL=${OF_HOT_SQL:-/opt/orderflow-binance/sql/hot-chunks.sql}
C=${OF_DB_CONTAINER:-orderflow-db}
out=$(docker exec -i "$C" psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow < "$SQL")
printf '%s\n' "$out"
n=$(printf '%s\n' "$out" | sed -n 's/^hot_count|//p')
[ -n "$n" ] || { echo "hot-chunks: keine Anzahl erhalten" >&2; exit 2; }
if [ "${1:-}" = --require-zero ] && [ "$n" != 0 ]; then
  echo "hot-chunks: $n offene Chunks im Columnstore – zuerst importer repair-open-chunks" >&2
  exit 1
fi
