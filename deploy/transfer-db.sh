#!/usr/bin/env bash
# Erstübertragung der fertigen Datenbank Mac → VPS (KONZEPT §2.3, Transferverfahren 1–5).
#
#   deploy/transfer-db.sh [root@host] [--replace] [--keep-dump]
#
# 1. pg_dump -Fd -j 4 (zstd) der lokalen DB `orderflow` über einen Wegwerf-Client-Container im
#    Netz des Dev-Containers (nur lesend; konsistenter Snapshot, auch bei -j)
# 2. Rolleneinstellungen der Quelle als roles-source.sql in den Dump; SHA256SUMS über alle Dateien
# 3. Prüfbericht der Quelle (deploy/sql/verify-db.sql) – parallel zum Upload
# 4. rsync nach /var/lib/orderflow-binance/transfer/<name>/, `sha256sum -c` auf dem Server
# 5. Restore auf dem Server (bin/restore-db.sh: pre_restore → pg_restore seriell → post_restore →
#    ANALYZE) und Prüfbericht des Ziels
# 6. PFLICHT: Berichte identisch (bis auf info|-Zeilen), sonst Abbruch mit Exit 1 – die API wird
#    nicht gestartet, solange dieser Schritt nicht bestanden ist
# 7. Härtung (sql/harden-db.sql), Dumps löschen (außer --keep-dump)
#
# Voraussetzung: deploy/install-server.sh ist gelaufen (DB-Container healthy, leere DB).
# --replace: ersetzt eine nicht leere Ziel-DB (nur bei gestoppter API; Runbook „Neu übertragen").
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
REPLACE=
KEEP=0
for a in "$@"; do
  case "$a" in
    --replace) REPLACE=--replace ;;
    --keep-dump) KEEP=1 ;;
    *) die "unbekanntes Argument: $a" ;;
  esac
done

SRC_CONTAINER=${OF_SRC_CONTAINER:-orderflow-db}
IMAGE=timescale/timescaledb:2.31.2-pg17
NAME="orderflow-$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}/dumps/$NAME"
REMOTE_DIR="$SRV_VAR/transfer/$NAME"

# Quelle: Zugangsdaten aus der lokalen .env (nie ausgeben)
set -a
# shellcheck disable=SC1091
. "$REPO_DIR/.env"
set +a
export PGPASSWORD="$OF_DB_PASSWORD"
[ "${OF_DB_NAME:-orderflow}" = orderflow ] || die "Quelle muss die DB orderflow sein (OF_DB_NAME=$OF_DB_NAME)"
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$SRC_CONTAINER" | head -1)
[ -n "$NET" ] || die "Quell-Container $SRC_CONTAINER läuft nicht"
# src_psql liest stdin (für < datei); src_psql_c nur mit -c und ohne stdin (sonst läse docker exec -i
# die Eingabe des Skripts)
src_psql() { docker exec -i "$SRC_CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "${OF_DB_USER:-of_admin}" -d orderflow "$@"; }
src_psql_c() { src_psql "$@" </dev/null; }

log "Ziel $DEPLOY_HOST, Dump $NAME"
remote "$SRV_ROOT" <<'EOF'
set -euo pipefail
[ "$(docker inspect -f '{{.State.Health.Status}}' orderflow-db 2>/dev/null)" = healthy ] || { echo "orderflow-db auf dem Server nicht healthy – zuerst install-server.sh" >&2; exit 1; }
avail=$(df -BG --output=avail /var/lib | tail -1 | tr -dc 0-9)
[ "$avail" -ge 15 ] || { echo "nur ${avail} GB frei (< 15 GB)" >&2; exit 1; }
test -x "$1/bin/restore-db.sh"
EOF

log "1/7 Snapshot exportieren + pg_dump (lokal, nur lesend)"
mkdir -p "$WORK"
chmod 777 "$WORK" # der Client-Container schreibt als UID postgres
# Eine lesende Transaktion hält den Snapshot offen, bis Dump UND Prüfbericht der Quelle fertig sind;
# beide lesen exakt denselben Stand (laufende Jobs/Importe auf dem Mac stören den Vergleich nicht).
FIFO="$WORK/snapshot.fifo"
rm -f "$FIFO" && mkfifo "$FIFO"
docker exec -i "$SRC_CONTAINER" psql -X -At -q -v ON_ERROR_STOP=1 -U "${OF_DB_USER:-of_admin}" -d orderflow \
  < "$FIFO" > "$WORK/snapshot.out" 2>&1 &
HOLD_PID=$!
exec 3> "$FIFO"
release_snapshot() { { exec 3>&-; } 2>/dev/null || true; wait "$HOLD_PID" 2>/dev/null || true; rm -f "$FIFO"; }
trap release_snapshot EXIT
printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' >&3
SNAP=
for _ in $(seq 1 30); do
  SNAP=$(head -1 "$WORK/snapshot.out" 2>/dev/null || true)
  [ -n "$SNAP" ] && break
  sleep 1
done
printf '%s' "$SNAP" | grep -qE '^[0-9A-F]+-[0-9A-F]+-[0-9]+$' || die "Snapshot-Export fehlgeschlagen: $SNAP"
log "Snapshot $SNAP"
t0=$(date +%s)
docker run --rm --network "$NET" -e PGPASSWORD -v "$WORK:/dump" "$IMAGE" \
  pg_dump -h "$SRC_CONTAINER" -U "${OF_DB_USER:-of_admin}" -d orderflow --snapshot="$SNAP" \
  -Fd -j 4 -Z zstd:3 -f /dump/db 2> "$WORK/pg_dump.log" \
  || { cat "$WORK/pg_dump.log" >&2; die "pg_dump fehlgeschlagen"; }
log "pg_dump: $(( $(date +%s) - t0 )) s, $(du -sh "$WORK/db" | cut -f1)"

log "2/7 Rolleneinstellungen + Prüfsummen"
src_psql < "$DEPLOY_DIR/sql/export-roles.sql" > "$WORK/db/roles-source.sql"
sha256_manifest "$WORK/db"

log "3/7 Prüfbericht der Quelle im selben Snapshot (Hintergrund, ≈ 3–4 min)"
src_psql -v snapshot="$SNAP" < "$DEPLOY_DIR/sql/verify-db.sql" > "$WORK/report-source.txt" 2> "$WORK/report-source.err" &
SRC_PID=$!

log "4/7 Upload + Prüfsummen auf dem Server"
t0=$(date +%s)
remote "$REMOTE_DIR" <<'EOF'
set -euo pipefail
umask 077
mkdir -p "$1"
EOF
rsync -a --partial -e "ssh ${SSH_OPTS[*]}" "$WORK/db/" "$DEPLOY_HOST:$REMOTE_DIR/"
remote "$REMOTE_DIR" <<'EOF'
set -euo pipefail
cd "$1" && sha256sum --quiet -c SHA256SUMS && echo "SHA256SUMS ok ($(wc -l < SHA256SUMS) Dateien)"
EOF
log "Upload + Prüfung: $(( $(date +%s) - t0 )) s"

# Quellbericht abwarten und den Snapshot der Mac-DB sofort freigeben (nicht erst nach dem Restore)
wait "$SRC_PID" || { cat "$WORK/report-source.err" >&2; die "Prüfbericht der Quelle fehlgeschlagen"; }
release_snapshot
trap - EXIT
# Planungszustand der Anwendungs-Jobs (wie restore-db.sh am Ende für das Ziel)
src_psql_c -c "SELECT 'jobsched|' || job_id || '|' || scheduled FROM timescaledb_information.jobs WHERE job_id >= 1000 ORDER BY job_id" >> "$WORK/report-source.txt"

log "5/7 Restore auf dem Server (Ziel muss leer sein${REPLACE:+, --replace})"
remote "$SRV_ROOT" "/transfer/$NAME" "$REPLACE" <<'EOF' > "$WORK/report-target.txt"
set -euo pipefail
"$1/bin/restore-db.sh" --container orderflow-db --dump "$2" --sql-dir "$1/sql" $3 </dev/null
EOF


log "6/7 Vergleich Quelle ↔ Ziel (Pflicht)"
if ! diff <(grep -v '^info|' "$WORK/report-source.txt") <(grep -v '^info|' "$WORK/report-target.txt") > "$WORK/report.diff"; then
  cat "$WORK/report.diff" >&2
  die "Prüfberichte weichen ab – Transfer NICHT bestanden (Dump bleibt: $WORK, $REMOTE_DIR)"
fi
grep -E '^(digest|data_day\||info\|db_size)' "$WORK/report-target.txt" >&2
log "Prüfberichte identisch: Transfer bestanden"

log "7/7 Härtung + Aufräumen"
remote "$SRV_ROOT" <<'EOF' > "$WORK/harden.txt"
set -euo pipefail
docker exec -i orderflow-db psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow < "$1/sql/harden-db.sql"
EOF
cat "$WORK/harden.txt" >&2
# Erwartet: keine Anwendungsrolle (of_api, of_recorder) außerhalb von orderflow verbindbar, nirgends
# TEMP und kein CREATE auf einer Datenbank; of_api verbindet sich mit orderflow; PUBLIC ohne CONNECT/TEMP. of_recorder hat CONNECT auf
# orderflow genau dann, wenn die Quelle es hatte (Migration 0013) – das prüft schon datacl| im Bericht.
grep -qx 'dbpriv|orderflow|of_api_connect=true|of_api_temp=false|of_api_create=false' "$WORK/harden.txt" \
  && ! grep -E '^dbpriv\|' "$WORK/harden.txt" | grep -v '^dbpriv|orderflow|' | grep -q 'connect=true' \
  && ! grep -q '_temp=true' "$WORK/harden.txt" \
  && ! grep -q '_create=true' "$WORK/harden.txt" \
  && grep -q '^public_connect|false|public_temp|false|' "$WORK/harden.txt" \
  || die "Härtung nicht wie erwartet (siehe oben)"
if [ "$KEEP" = 0 ]; then
  remote "$REMOTE_DIR" <<'EOF'
set -euo pipefail
case "$1" in /var/lib/orderflow-binance/transfer/orderflow-*) rm -rf -- "$1" ;; *) exit 1 ;; esac
EOF
  rm -rf -- "$WORK/db"
fi
log "fertig; Berichte unter $WORK"
