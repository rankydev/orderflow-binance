#!/usr/bin/env bash
# Einmalige (idempotente) Grundeinrichtung auf dem VPS. Verändert NUR eigene Pfade:
#   /opt/orderflow-binance, /etc/orderflow-binance, /var/lib/orderflow-binance, /var/www/orderflow-acme,
#   Systembenutzer orderflow (UID 10001), Docker-Projekt orderflow-binance (Netz/Volume mit Präfix),
#   systemd-Units orderflow-monitor.{service,timer}.
# Nichts an nginx, certbot, anderen Containern oder Diensten.
#
#   deploy/install-server.sh [root@host]                 Dateien, Secrets, DB-Container starten
#   deploy/install-server.sh [root@host] --enable-monitor  zusätzlich Monitor-Timer einschalten
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
MON=0
[ "${1:-}" = --enable-monitor ] && MON=1

log "Dateien übertragen ($DEPLOY_HOST)"
STAGE=/root/.orderflow-binance-stage
remote "$STAGE" <<'EOF'
set -euo pipefail
rm -rf -- "$1" && mkdir -p -m 700 "$1"
EOF
rsync -a -e "ssh ${SSH_OPTS[*]}" \
  "$DEPLOY_DIR/compose.prod.yml" "$DEPLOY_DIR/sql" "$DEPLOY_DIR/bin" "$DEPLOY_DIR/systemd" \
  "$DEPLOY_HOST:$STAGE/"

remote "$STAGE" "$MON" <<'EOF'
set -euo pipefail
STAGE=$1 MON=$2
R=/opt/orderflow-binance E=/etc/orderflow-binance V=/var/lib/orderflow-binance
# Systembenutzer für den API-Prozess (UID im Container = 10001; reserviert die UID auf dem Host)
getent group orderflow >/dev/null || groupadd --system --gid 10001 orderflow
getent passwd orderflow >/dev/null || useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin orderflow
install -d -m 755 -o root -g root "$R" "$R/bin" "$R/sql" "$R/releases" /var/www/orderflow-acme
install -d -m 700 -o root -g root "$E" "$V" "$V/transfer"
install -m 644 "$STAGE/compose.prod.yml" "$R/compose.prod.yml"
install -m 644 "$STAGE"/sql/*.sql "$R/sql/"
install -m 755 "$STAGE/bin/restore-db.sh" "$STAGE/bin/orderflow-monitor" "$R/bin/"
[ -f "$R/.env" ] || printf 'OF_RELEASE=none\n' > "$R/.env"
chmod 644 "$R/.env"

# Secrets: nur hier erzeugt, nie übertragen oder ausgegeben (root, 0600)
gen() { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 40; }
umask 077
if [ ! -f "$E/db.env" ]; then
  pw=$(gen); printf 'POSTGRES_PASSWORD=%s\nOF_DB_PASSWORD=%s\n' "$pw" "$pw" > "$E/db.env"; unset pw
  echo "db.env erzeugt"
fi
if [ ! -f "$E/api.env" ]; then
  printf 'OF_API_DB_PASSWORD=%s\n' "$(gen)" > "$E/api.env"
  echo "api.env erzeugt"
fi
chmod 600 "$E/db.env" "$E/api.env"

# systemd-Units (nur eigene Dateien)
install -m 644 "$STAGE/systemd/orderflow-monitor.service" "$STAGE/systemd/orderflow-monitor.timer" /etc/systemd/system/
systemctl daemon-reload
rm -rf -- "$STAGE"

C="docker compose -p orderflow-binance -f $R/compose.prod.yml --env-file $R/.env"
$C config -q
$C pull -q db
$C up -d --wait db
docker exec orderflow-db psql -X -At -U of_admin -d orderflow -c "SELECT 'db ok: ' || version()" -c "SELECT 'timescaledb ' || extversion FROM pg_extension WHERE extname='timescaledb'"
if [ "$MON" = 1 ]; then
  systemctl enable --now orderflow-monitor.timer
  systemctl start orderflow-monitor.service || true
  journalctl -u orderflow-monitor.service -n 20 --no-pager
fi
EOF
log "fertig"
