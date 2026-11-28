#!/usr/bin/env bash
# Teilübertragung Mac → VPS: nur die Big-Trades-Ergänzung finaler Tage (big_order, Ordersummen,
# Untergrenze, Digest-Version 2) – ohne API-Pause, neben laufendem Recorder (KONZEPT §2.3
# „Teilübertragung", RUNBOOK „Historie Big Trades übertragen").
#
#   deploy/transfer-bigtrades.sh [root@host] [--dry-run | --verify | --revert <result-apply.txt>]
#                                [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--ignore-window]
#                                [--lock-wait S] [--keep]
#
#   --dry-run  nur lesend auf dem Server: je Tag would/same/skip mit Grund (v1-Beweis neu berechnet)
#   (ohne)     Lauf: schreibt je passendem Tag in einer Transaktion (Abfrage vorher, OF_YES=1 überspringt)
#   --verify   nur lesend auf dem Server: je Tag v2-Digest (gespeichert und neu berechnet) = lokal
#   --revert F Rücknahme: die Tage mit „ok“ aus dem Bericht F eines früheren Laufs zurück auf
#              Digest-Version 1 (nur wo das Ziel noch genau den übertragenen Stand hat; Abfrage vorher)
#
# 1. lokal (nur lesend, eine Momentaufnahme): deploy/bin/bigtrades-export.sh → Nutzlast + SQL +
#    Server-Skript + SHA256SUMS (für --dry-run/--verify/--revert nur die Tagesliste ohne big_order)
# 2. rsync (0700/0600) nach /var/lib/orderflow-binance/transfer/bigtrades-<zeit>/, `sha256sum -c`
# 3. bigtrades-apply.sh dort (psql als of_admin per docker exec, wie recorder-ctl.sh): Bericht nach
#    $OF_RELEASE_DIR/bigtrades/<name>/result-<modus>.txt (+ .err)
# 4. Transferverzeichnis auf dem Server und lokale Nutzlast löschen (außer --keep)
# Exit wie bin/bigtrades-apply.sh (3 Abbruch · 1 fail/verify-Abweichung · 4 Chunks teilweise ·
# 6 busy · 2 skip · 0 ok), dazu 5 = nichts auf dem Server ausgeführt (Argumente, lokale oder
# Server-Vorprüfung, Export, Upload/Prüfsumme, Bestätigung abgelehnt).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
# In diesem Skript: jede Ablehnung vor dem Server-Lauf mit Exit 5 (nicht 1 = fail)
die() {
  printf '\033[31m[%s] FEHLER: %s\033[0m\n' "$(date -u +%H:%M:%S)" "$*" >&2
  exit 5
}
# Unerwarteter Fehler (set -e) vor dem Server-Lauf: ebenfalls Exit 5 (vor Schritt 3 aufgehoben)
set -E
trap 'printf "\033[31m[%s] FEHLER: unerwarteter Fehler (Exit %s, Zeile %s) – nichts auf dem Server ausgeführt\033[0m\n" "$(date -u +%H:%M:%S)" "$?" "$LINENO" >&2; exit 5' ERR
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
MODE=apply
KEEP=0
REVFILE=
EXP=()
RUN=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE=dry-run ;;
    --verify) MODE=verify ;;
    --revert) MODE=revert; REVFILE=${2:-}; [ -n "$REVFILE" ] || die "--revert braucht result-apply.txt"; shift ;;
    --from | --to) [ $# -ge 2 ] || die "$1 braucht ein Datum"; EXP+=("$1" "$2"); shift ;;
    --ignore-window) RUN+=(--ignore-window) ;;
    --lock-wait) [ $# -ge 2 ] || die "--lock-wait braucht Sekunden"; RUN+=(--lock-wait "$2"); shift ;;
    --keep) KEEP=1 ;;
    *) die "unbekanntes Argument: $1" ;;
  esac
  shift
done
[ "$MODE" = apply ] || EXP+=(--manifest-only)
if [ "$MODE" = revert ]; then
  [ -f "$REVFILE" ] || die "Bericht nicht gefunden: $REVFILE"
  grep -q '^day|[^|]*|[^|]*|ok|' "$REVFILE" || die "keine Tage mit „ok“ in $REVFILE"
fi

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

remote <<'EOF' || die "Server-Vorprüfung fehlgeschlagen"
set -euo pipefail
[ "$(docker inspect -f '{{.State.Health.Status}}' orderflow-db 2>/dev/null)" = healthy ] || { echo "orderflow-db auf dem Server nicht healthy" >&2; exit 1; }
[ -d /var/lib/orderflow-binance/transfer ] || { echo "/var/lib/orderflow-binance/transfer fehlt – install-server.sh" >&2; exit 1; }
avail=$(df -BG --output=avail /var/lib | tail -1 | tr -dc 0-9)
[ "$avail" -ge 3 ] || { echo "nur ${avail} GB frei (< 3 GB)" >&2; exit 1; }
EOF

log "1/4 Export (lokal, nur lesend; ≈ 0,3 s je Tag)"
t0=$(date +%s)
"$DEPLOY_DIR/bin/bigtrades-export.sh" "$WORK" ${EXP[@]+"${EXP[@]}"} || die "Export fehlgeschlagen"
if [ "$MODE" = revert ]; then
  grep '^day|[^|]*|[^|]*|ok|' "$REVFILE" | cut -d'|' -f2,3 | tr '|' '\t' > "$WORK/revert.tsv"
  sha256_manifest "$WORK"
  log "Rücknahmeliste: $(wc -l < "$WORK/revert.tsv" | tr -d ' ') Tage aus $REVFILE"
fi
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
remote "$REMOTE_DIR" <<'EOF' || die "Transferverzeichnis nicht angelegt"
set -euo pipefail
umask 077
mkdir -p "$1"
EOF
rsync -a --chmod=D700,F600 --partial -e "ssh ${SSH_OPTS[*]}" "$WORK/" "$DEPLOY_HOST:$REMOTE_DIR/" || die "Upload fehlgeschlagen"
remote "$REMOTE_DIR" <<'EOF' || die "Prüfsummen auf dem Server falsch"
set -euo pipefail
cd "$1" && sha256sum --quiet -c SHA256SUMS && echo "SHA256SUMS ok ($(wc -l < SHA256SUMS) Dateien)" >&2
EOF

case "$MODE" in
  apply) (confirm "Big-Trades-Ergänzung auf $DEPLOY_HOST schreiben (Tage mit bewiesenem v1-Stand; vorher --dry-run gelesen)?") || die "nicht bestätigt" ;;
  revert) (confirm "Rücknahme von $(wc -l < "$WORK/revert.tsv" | tr -d ' ') Tagen auf $DEPLOY_HOST (zurück auf Digest-Version 1)?") || die "nicht bestätigt" ;;
esac

log "3/4 $MODE auf dem Server"
trap - ERR
set +E +e
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
[ "$rc" = 255 ] && { warn "SSH-Verbindung verloren (Exit 255) – Server-Sitzung beendet sich selbst; Stand mit --dry-run prüfen"; rc=3; }
log "Bericht: $WORK/result-$MODE.txt (+ .err), Exit $rc"

log "4/4 Aufräumen"
cleanup_remote
trap - EXIT
[ "$KEEP" = 1 ] || rm -f -- "$WORK/payload.sql.gz"
case "$rc" in
  0) log "fertig: $MODE ohne Befund" ;;
  2) warn "Tage dauerhaft übersprungen (skip) – Gründe im Bericht einmal prüfen; Wiederholung ändert daran nichts" ;;
  6) warn "Tage vorübergehend gesperrt (busy), unverändert – denselben Befehl erneut ausführen" ;;
  1) warn "$MODE: Abweichung (fail bzw. verify ≠ match) – Bericht lesen, nicht übergehen" ;;
  4) warn "Chunks teilweise komprimiert geblieben – Lauf erneut ausführen (idempotent)" ;;
  *) warn "Abbruch (Exit $rc) – Meldung ABBRUCH: … oben; festgeschriebene Tage sind vollständig" ;;
esac
exit "$rc"
