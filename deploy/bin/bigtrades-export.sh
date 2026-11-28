#!/usr/bin/env bash
# Big-Trades-Ergänzung finaler Tage aus der lokalen DB exportieren (Mac, nur lesend; eine lesende
# Momentaufnahme, deploy/sql/bigtrades-export.sql). Legt in <verzeichnis> alles ab, was der Server
# braucht: payload.sql.gz, bigtrades-stage.sql, bigtrades-run.sql, bigtrades-apply.sh, SHA256SUMS.
#
#   deploy/bin/bigtrades-export.sh <verzeichnis> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--manifest-only]
#
# --manifest-only: nur die Tagesliste mit Digests (für --dry-run/--verify, ohne big_order-Zeilen).
# Umgebung: OF_SRC_CONTAINER (orderflow-db), OF_SRC_DB (orderflow), OF_SRC_USER (of_admin).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sqldir="$here/../sql"
out=${1:?Zielverzeichnis fehlt}
shift
FROM=1970-01-01
TO=9999-12-31
WITH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM=${2:?}; shift ;;
    --to) TO=${2:?}; shift ;;
    --manifest-only) WITH=0 ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
  shift
done
for d in "$FROM" "$TO"; do
  printf '%s' "$d" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || { echo "Datum YYYY-MM-DD: $d" >&2; exit 2; }
done
SRC=${OF_SRC_CONTAINER:-orderflow-db}
DB=${OF_SRC_DB:-orderflow}
mkdir -p "$out"
docker exec -i "$SRC" psql -X -At -q -v ON_ERROR_STOP=1 -v from="$FROM" -v to="$TO" -v with_orders="$WITH" \
  -U "${OF_SRC_USER:-of_admin}" -d "$DB" < "$sqldir/bigtrades-export.sql" | gzip -6 > "$out/payload.sql.gz"
cp "$sqldir/bigtrades-stage.sql" "$sqldir/bigtrades-run.sql" "$here/bigtrades-apply.sh" "$out/"
(cd "$out" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS)
