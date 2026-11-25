#!/usr/bin/env bash
# Vorab-Prüfung vor dem Rollout – NUR LESEND auf dem Server. Schreibt den Schnappschuss der
# Nachbardienste (bin/server-snapshot.sh) als Ausgangslage für postcheck.sh.
#
#   deploy/preflight.sh [root@host]     → druckt den Pfad der Baseline-Datei als letzte Zeile
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
STATE="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}/state"
mkdir -p "$STATE"
BASE="$STATE/baseline-$(date -u +%Y%m%dT%H%M%SZ).txt"
fail=0
check() { if eval "$2"; then printf '  ok    %s\n' "$1" >&2; else printf '  FEHLT %s\n' "$1" >&2; fail=1; fi; }

log "Server-Kennzahlen"
remote > "$STATE/preflight-server.txt" <<'EOF'
set -uo pipefail
echo "disk_free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
echo "mem_avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
echo "ports_busy=$(ss -ltnH | awk '{print $4}' | grep -cE ':(8780|8781|54320)$')"
echo "ports_ours=$(docker ps --format '{{.Names}} {{.Ports}}' | grep -c '^orderflow-')"
echo "nginx_t=$(nginx -t >/dev/null 2>&1 && echo ok || echo fail)"
echo "docker=$(docker version --format '{{.Server.Version}}')"
echo "compose=$(docker compose version --short)"
echo "ntp=$(timedatectl show -p NTPSynchronized --value)"
echo "ip=$(ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | cut -d/ -f1 | head -1)"
echo "name_clash=$(docker ps -a --format '{{.Names}}' | grep -cE '^orderflow-(db|api)$')"
echo "nginx_zone_clash=$( (nginx -T 2>/dev/null | grep -E 'zone=orderflow_|upstream orderflow_' | grep -vc '^#') || true)"
echo "certbot_timer=$(systemctl is-active certbot.timer)"
echo "le_accounts=$(ls /etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory 2>/dev/null | wc -l)"
EOF
cat "$STATE/preflight-server.txt" >&2
# shellcheck disable=SC1091
. "$STATE/preflight-server.txt"
dns=$(dig +short A "$PUBLIC_HOST" @1.1.1.1 | tail -1)
check "Platte ≥ 15 GB frei ($disk_free_gb GB)" '[ "$disk_free_gb" -ge 15 ]'
check "RAM verfügbar ≥ 3500 MB ($mem_avail_mb MB; DB 2 GB + API 0,6 GB Limit)" '[ "$mem_avail_mb" -ge 3500 ]'
check "Ports 8780/8781/54320 frei oder unsere ($ports_busy belegt, $ports_ours eigene Container)" '[ "$ports_busy" -eq 0 ] || [ "$ports_ours" -gt 0 ]'
check "nginx -t" '[ "$nginx_t" = ok ]'
check "DNS $PUBLIC_HOST → $dns = Server $ip" '[ "$dns" = "$ip" ]'
check "Uhr synchron" '[ "$ntp" = yes ]'
check "certbot.timer aktiv, Let'\''s-Encrypt-Konto vorhanden" '[ "$certbot_timer" = active ] && [ "$le_accounts" -ge 1 ]'
check "Docker ≥ 24, Compose v2+ ($docker / $compose)" '[ "${docker%%.*}" -ge 24 ]'

log "Schnappschuss der Nachbardienste → $BASE"
remote < "$DEPLOY_DIR/bin/server-snapshot.sh" > "$BASE"
# Außensicht vom Mac (gleiche Statuscodes erwartet wie vom Server aus)
for u in https://genius.rankyhub.com/ https://rankyhub.com/ https://takt.rankyhub.com/; do
  printf 'external|%s|%s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u")" >> "$BASE"
done
grep -E '^(site|external|container|pm2|unit)' "$BASE" >&2
[ "$fail" = 0 ] || die "Preflight nicht bestanden"
log "Preflight bestanden"
echo "$BASE"
