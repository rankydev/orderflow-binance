#!/usr/bin/env bash
# Nachprüfung (nur lesend): Nachbardienste unverändert gegenüber der Preflight-Baseline, und die
# eigene Site antwortet. Auch nach jedem Rollback-Schritt ausführen.
#
#   deploy/postcheck.sh [root@host] <baseline-datei>
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
BASE=${1:?Baseline-Datei aus preflight.sh angeben}
NOW="${BASE%.txt}-after-$(date -u +%H%M%S).txt"

remote < "$DEPLOY_DIR/bin/server-snapshot.sh" > "$NOW"
for u in https://genius.rankyhub.com/ https://rankyhub.com/ https://takt.rankyhub.com/; do
  printf 'external|%s|%s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u")" >> "$NOW"
done
if diff <(grep -v '^info|' "$BASE") <(grep -v '^info|' "$NOW"); then
  log "Nachbardienste unverändert (Units, Startzeiten, Container, pm2, Ports, Dateien, Statuscodes)"
else
  die "ABWEICHUNG bei den Nachbardiensten (siehe diff oben; $BASE ↔ $NOW)"
fi

log "eigene Site"
bad=0
exp() { # $1 URL, $2 erwarteter Code
  local c
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1")
  printf '  %s → %s (erwartet %s)\n' "$1" "$c" "$2" >&2
  [ "$c" = "$2" ] || bad=1
}
exp "http://$PUBLIC_HOST/" 308
exp "https://$PUBLIC_HOST/" 200
exp "https://$PUBLIC_HOST/api/v1/symbols" 200
exp "https://$PUBLIC_HOST/api/v1/health" 404
hdr=$(curl -s -D - -o /dev/null --max-time 10 "https://$PUBLIC_HOST/api/v1/symbols")
if printf '%s' "$hdr" | grep -iqE '^(x-source|x-rows-estimate|server-timing):'; then
  warn "Diagnose-Header sichtbar"; bad=1
fi
printf '%s' "$hdr" | grep -iq '^server: nginx/' && { warn "nginx-Version sichtbar"; bad=1; }
remote <<'EOF' >&2 || bad=1
set -euo pipefail
docker ps --filter name='^orderflow-' --format '  {{.Names}} {{.Status}} {{.Ports}}'
# Kein Port von uns außerhalb von 127.0.0.1
! docker ps --filter name='^orderflow-' --format '{{.Ports}}' | tr ',' '\n' | grep -v '^ *$' | grep -vq '127.0.0.1:'
systemctl is-active orderflow-monitor.timer >/dev/null && journalctl -u orderflow-monitor.service -n 1 --no-pager -o cat || echo "  Monitor-Timer noch nicht aktiv"
EOF
[ "$bad" = 0 ] || die "eigene Site nicht wie erwartet"
log "Postcheck bestanden"
