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
acct=$(sed -n 's/^account = //p' /etc/letsencrypt/renewal/*.conf 2>/dev/null | sort -u)
echo "le_renewal_accounts=$(printf '%s\n' "$acct" | grep -c .)"
echo "le_renewal_account_exists=$([ -n "$acct" ] && [ -d "/etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory/$acct" ] && echo yes || echo no)"
EOF
cat "$STATE/preflight-server.txt" >&2
# Werte lesen, nicht als Shell-Code ausführen
P="$STATE/preflight-server.txt"
for k in disk_free_gb mem_avail_mb ports_busy ports_ours nginx_t docker compose ntp ip name_clash \
         nginx_zone_clash certbot_timer le_accounts le_renewal_accounts le_renewal_account_exists; do
  v=$(kv "$P" "$k")
  printf '%s' "$v" | grep -qE '^[A-Za-z0-9._:-]*$' || die "unerwarteter Wert für $k"
  eval "$k=\$v"
done
dns=$(dig +short A "$PUBLIC_HOST" @1.1.1.1 | tail -1)
check "Platte ≥ 15 GB frei ($disk_free_gb GB)" '[ "$disk_free_gb" -ge 15 ]'
check "RAM verfügbar ≥ 3500 MB ($mem_avail_mb MB; DB 2 GB + API 0,6 GB Limit)" '[ "$mem_avail_mb" -ge 3500 ]'
check "Ports 8780/8781/54320 frei oder unsere ($ports_busy belegt, $ports_ours eigene Container)" '[ "$ports_busy" -eq 0 ] || [ "$ports_ours" -gt 0 ]'
check "nginx -t" '[ "$nginx_t" = ok ]'
check "DNS $PUBLIC_HOST → $dns = Server $ip" '[ "$dns" = "$ip" ]'
check "Uhr synchron" '[ "$ntp" = yes ]'
check "certbot.timer aktiv" '[ "$certbot_timer" = active ]'
check "Let'\''s Encrypt: Renewal-Dateien nutzen genau 1 Produktionskonto, das existiert ($le_accounts Konten)" '[ "$le_renewal_accounts" = 1 ] && [ "$le_renewal_account_exists" = yes ]'
check "keine Container orderflow-db/-api, keine Zonen orderflow_*" '[ "$ports_ours" -gt 0 ] || { [ "$name_clash" = 0 ] && [ "$nginx_zone_clash" = 0 ]; }'
check "Docker ≥ 24, Compose v2+ ($docker / $compose)" '[ "${docker%%.*}" -ge 24 ]'

log "Schnappschuss der Nachbardienste → $BASE"
remote < "$DEPLOY_DIR/bin/server-snapshot.sh" > "$BASE" || die "Schnappschuss fehlgeschlagen"
snapshot_valid "$BASE" || die "Schnappschuss unvollständig ($BASE) – Preflight abgebrochen"
# Außensicht vom Mac (gleiche Statuscodes erwartet wie vom Server aus)
for u in https://genius.rankyhub.com/ https://rankyhub.com/ https://takt.rankyhub.com/; do
  # Außensicht nur informativ: genius antwortet von außen schon vor dem Rollout teils erst nach
  # 6–20 s (von innen 10 ms) – als Pflichtvergleich ein Fehlalarm; maßgeblich sind site|/site6|
  printf 'info|external|%s|%s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' --max-time 30 "$u")" >> "$BASE"
done
grep -E '^(site|info\|external|container|pm2|unit)' "$BASE" >&2
[ "$fail" = 0 ] || die "Preflight nicht bestanden"
log "Preflight bestanden"
echo "$BASE"
