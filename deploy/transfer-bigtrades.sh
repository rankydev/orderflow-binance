#!/usr/bin/env bash
# Teilübertragung Mac → VPS: nur die Big-Trades-Ergänzung finaler Tage (big_order, Ordersummen,
# Untergrenze, Digest-Version 2) – ohne API-Pause, neben laufendem Recorder (KONZEPT §2.3
# „Teilübertragung", RUNBOOK „Historie Big Trades übertragen").
#
#   deploy/transfer-bigtrades.sh [root@host] [--dry-run | --verify] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
#                                [--ignore-window] [--lock-wait S] [--keep]
#
#   --dry-run  nur lesend auf dem Server: je Tag would/same/skip mit Grund (v1-Beweis neu berechnet)
#   (ohne)     Lauf: schreibt je passendem Tag in einer Transaktion (Abfrage vorher, OF_YES=1 überspringt)
#   --verify   nur lesend auf dem Server: je Tag v2-Digest (gespeichert und neu berechnet) = lokal
#
# 1. lokal (nur lesend, eine Momentaufnahme): deploy/bin/bigtrades-export.sh → Nutzlast + SQL +
#    Server-Skript + SHA256SUMS (für --dry-run/--verify nur die Tagesliste ohne big_order-Zeilen)
# 2. rsync nach /var/lib/orderflow-binance/transfer/bigtrades-<zeit>/, `sha256sum -c` auf dem Server
# 3. bigtrades-apply.sh dort (psql als of_admin per docker exec, wie recorder-ctl.sh): Bericht nach
#    $OF_RELEASE_DIR/bigtrades/<name>/result-<modus>.txt
# 4. Transferverzeichnis auf dem Server und lokale Nutzlast löschen (außer --keep)
# Exit wie bin/bigtrades-apply.sh: 0 ok · 2 übersprungen/busy · 1 fail bzw. verify-Abweichung ·
# 4 Chunks teilweise geblieben · 3 Abbruch; sonstige: Vorprüfung/Upload gescheitert.
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
MODE=apply
KEEP=0
EXP=()
RUN=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run ;;
    --verify) MODE=verify ;;
    --from | --to) EXP+=("$1" "${2:?$1 braucht ein Datum}"); shift ;;
    --ignore-window) RUN+=(--ignore-window) ;;
    --lock-wait) RUN+=(--lock-wait "${2:?--lock-wait braucht Sekunden}"); shift ;;
    --keep) KEEP=1 ;;
    *) die "unbekanntes Argument: $1" ;;
  esac
  shift
done
[ "$MODE" = apply ] || EXP+=(--manifest-only)

# Quelle wie transfer-db.sh: lokale DB orderflow im Dev-Container (Zugang per docker exec, ohne Passwort)
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_DIR/.env"
  set +a
fi
[ "${OF_DB_NAME:-orderflow}" = orderflow ] || die "Quelle muss die DB orderflow sein (OF_DB_NAME=$OF_DB_NAME)"
export OF_SRC_CONTAINER=${OF_SRC_CONTAINER:-orderflow-db} OF_SRC_DB=orderflow OF_SRC_USER=${OF_DB_USER:-of_admin}

NAME="bigtrades-$(date -u +%Y%m%dT%H%M%SZ)"
WORK="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}/bigtrades/$NAME"
REMOTE_DIR="$SRV_VAR/transfer/$NAME"
log "Ziel $DEPLOY_HOST, Modus $MODE, $NAME"

remote <<'EOF'
set -euo pipefail
[ "$(docker inspect -f '{{.State.Health.Status}}' orderflow-db 2>/dev/null)" = healthy ] || { echo "orderflow-db auf dem Server nicht healthy" >&2; exit 1; }
[ -d /var/lib/orderflow-binance/transfer ] || { echo "/var/lib/orderflow-binance/transfer fehlt – install-server.sh" >&2; exit 1; }
avail=$(df -BG --output=avail /var/lib | tail -1 | tr -dc 0-9)
[ "$avail" -ge 3 ] || { echo "nur ${avail} GB frei (< 3 GB)" >&2; exit 1; }
EOF

log "1/4 Export (lokal, nur lesend; ≈ 0,3 s je Tag)"
t0=$(date +%s)
"$DEPLOY_DIR/bin/bigtrades-export.sh" "$WORK" ${EXP[@]+"${EXP[@]}"}
log "Export: $(( $(date +%s) - t0 )) s, Nutzlast $(du -h "$WORK/payload.sql.gz" | cut -f1)"

cleanup_remote() {
  [ "$KEEP" = 1 ] && return 0
  remote "$REMOTE_DIR" <<'EOF' || warn "Transferverzeichnis nicht gelöscht: $REMOTE_DIR"
set -euo pipefail
case "$1" in /var/lib/orderflow-binance/transfer/bigtrades-*) rm -rf -- "$1" ;; *) exit 1 ;; esac
EOF
}
trap cleanup_remote EXIT

log "2/4 Upload + Prüfsummen"
remote "$REMOTE_DIR" <<'EOF'
set -euo pipefail
umask 077
mkdir -p "$1"
EOF
rsync -a --partial -e "ssh ${SSH_OPTS[*]}" "$WORK/" "$DEPLOY_HOST:$REMOTE_DIR/"
remote "$REMOTE_DIR" <<'EOF'
set -euo pipefail
cd "$1" && sha256sum --quiet -c SHA256SUMS && echo "SHA256SUMS ok ($(wc -l < SHA256SUMS) Dateien)" >&2
EOF

[ "$MODE" = apply ] && confirm "Big-Trades-Ergänzung auf $DEPLOY_HOST schreiben (Tage mit bewiesenem v1-Stand; vorher --dry-run gelesen)?"

log "3/4 $MODE auf dem Server"
set +e
# stdout (Zeilen je Tag, fortlaufend) → result-<modus>.txt, stderr (Zusammenfassung, ABBRUCH: …)
# zusätzlich → result-<modus>.err. Strg-C/SSH-Abbruch beendet die Server-Sitzung
# (bigtrades-apply.sh: tee bekommt EPIPE → pg_terminate_backend der eigenen Sitzung).
remote "$REMOTE_DIR" "$MODE" ${RUN[@]+"${RUN[@]}"} <<'EOF' > "$WORK/result-$MODE.txt" 2> >(tee "$WORK/result-$MODE.err" >&2)
set -uo pipefail
d=$1
shift
bash "$d/bigtrades-apply.sh" "$d" "$@"
EOF
rc=$?
set -e
log "Bericht: $WORK/result-$MODE.txt (+ .err), Exit $rc"

log "4/4 Aufräumen"
cleanup_remote
trap - EXIT
[ "$KEEP" = 1 ] || rm -f -- "$WORK/payload.sql.gz"
case "$rc" in
  0) log "fertig: $MODE ohne Befund" ;;
  2) warn "Tage übersprungen oder gesperrt (busy) – Bericht lesen; erneut ausführen ist sicher" ;;
  1) warn "$MODE: Abweichung (fail bzw. verify ≠ match) – Bericht lesen, nicht übergehen" ;;
  4) warn "Chunks teilweise komprimiert geblieben – Lauf erneut ausführen (idempotent)" ;;
  *) warn "Abbruch (Exit $rc) – Meldung ABBRUCH: … oben; festgeschriebene Tage sind vollständig" ;;
esac
exit "$rc"
