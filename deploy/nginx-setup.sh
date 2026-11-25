#!/usr/bin/env bash
# nginx-Site orderflow.rankyhub.com einrichten (nach install-server, transfer-db und release).
# Fasst AUSSCHLIESSLICH eigene Dateien an:
#   /etc/nginx/conf.d/orderflow-binance.conf            (limit_req_zone/limit_conn_zone)
#   /etc/nginx/snippets/orderflow-binance-headers.conf  (Sicherheits-Header)
#   /etc/nginx/snippets/orderflow-binance-proxy.conf    (gemeinsame /api/-Proxy-Einstellungen)
#   /etc/nginx/sites-available/orderflow.rankyhub.com + Symlink sites-enabled/zz-orderflow.rankyhub.com
#   (Präfix zz-: sortiert immer als letzte Site → nie Standardserver eines vorhandenen Sockets)
#   /var/www/orderflow-acme, Zertifikat orderflow.rankyhub.com (certbot webroot, wie genius/takt)
# Vor jedem Reload `nginx -t`; schlägt der Test fehl, werden die eigenen Dateien zurückgenommen
# und nginx nicht neu geladen (die Nachbar-Sites bleiben unverändert).
#
#   deploy/nginx-setup.sh [root@host]             einrichten (idempotent)
#   deploy/nginx-setup.sh [root@host] --rollback  eigene nginx-Dateien entfernen, nginx neu laden
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
MODE=${1:-setup}

if [ "$MODE" = --rollback ]; then
  remote <<'EOF'
set -euo pipefail
rm -f /etc/nginx/sites-enabled/zz-orderflow.rankyhub.com /etc/nginx/sites-enabled/orderflow.rankyhub.com \
      /etc/nginx/sites-available/orderflow.rankyhub.com \
      /etc/nginx/conf.d/orderflow-binance.conf /etc/nginx/snippets/orderflow-binance-headers.conf \
      /etc/nginx/snippets/orderflow-binance-proxy.conf
nginx -t || { echo "nginx -t fehlgeschlagen – KEIN Reload; Konfiguration prüfen" >&2; exit 1; }
systemctl reload nginx
echo "orderflow-nginx-Dateien entfernt (Zertifikat bleibt; löschen: certbot delete --cert-name orderflow.rankyhub.com)"
EOF
  exit 0
fi

# DNS: öffentlicher Resolver muss die Server-Adresse liefern
want=$(remote <<'EOF'
ip -4 -o addr show dev eth0 scope global | awk '{print $4}' | cut -d/ -f1 | head -1
EOF
)
got=$(dig +short A "$PUBLIC_HOST" @1.1.1.1 | tail -1)
[ -n "$want" ] && [ "$got" = "$want" ] || die "DNS $PUBLIC_HOST → '$got', Server hat '$want'"
log "DNS ok"

STAGE=/root/.orderflow-binance-nginx
remote "$STAGE" <<'EOF'
set -euo pipefail
rm -rf -- "$1" && mkdir -p -m 700 "$1"
EOF
rsync -a -e "ssh ${SSH_OPTS[*]}" "$DEPLOY_DIR/nginx/" "$DEPLOY_HOST:$STAGE/"

remote "$STAGE" <<'EOF'
set -euo pipefail
S=$1
SITE=/etc/nginx/sites-available/orderflow.rankyhub.com
LINK=/etc/nginx/sites-enabled/zz-orderflow.rankyhub.com
CERT=/etc/letsencrypt/live/orderflow.rankyhub.com/fullchain.pem
say() { printf '[nginx %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
# Namenskonflikte: unsere Zonen/Upstreams dürfen nirgends sonst definiert sein
if nginx -T 2>/dev/null | grep -E 'zone=orderflow_|upstream orderflow_' | grep -v '^#' | grep -q . \
   && ! [ -e /etc/nginx/conf.d/orderflow-binance.conf ]; then
  say "Namen orderflow_* bereits vergeben – Abbruch"; exit 1
fi
backup=$(mktemp -d)
for f in "$SITE" /etc/nginx/conf.d/orderflow-binance.conf /etc/nginx/snippets/orderflow-binance-headers.conf /etc/nginx/snippets/orderflow-binance-proxy.conf; do
  [ -e "$f" ] && cp -a "$f" "$backup/$(basename "$f")"
done
had_link=0; [ -L "$LINK" ] && had_link=1
undo() {
  say "nginx -t fehlgeschlagen – eigene Dateien zurück auf vorher, KEIN Reload"
  rm -f "$SITE" /etc/nginx/conf.d/orderflow-binance.conf /etc/nginx/snippets/orderflow-binance-headers.conf \
        /etc/nginx/snippets/orderflow-binance-proxy.conf
  [ "$had_link" = 1 ] || rm -f "$LINK"
  for f in "$backup"/*; do
    [ -e "$f" ] || continue
    case "$(basename "$f")" in
      orderflow.rankyhub.com) cp -a "$f" "$SITE" ;;
      orderflow-binance.conf) cp -a "$f" /etc/nginx/conf.d/ ;;
      orderflow-binance-headers.conf | orderflow-binance-proxy.conf) cp -a "$f" /etc/nginx/snippets/ ;;
    esac
  done
  nginx -t || true
  exit 1
}
# Konto-Prüfung vor jeder Änderung an nginx (nur nötig, solange das Zertifikat fehlt)
if [ ! -f "$CERT" ]; then
  # Vorhandenes Let's-Encrypt-Konto des Servers (keine neue Registrierung, keine neuen AGB): das
  # Konto, das die Renewal-Dateien der Nachbarn nutzen – ausdrücklich per --account (mit mehreren
  # Konten fragte certbot sonst nach und brach mit --non-interactive ab).
  acct=$(sed -n 's/^account = //p' /etc/letsencrypt/renewal/*.conf | sort -u)
  [ "$(printf '%s\n' "$acct" | grep -c .)" = 1 ] || { say "Renewal-Dateien nutzen nicht genau ein Konto: $acct"; exit 1; }
  [ -d "/etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory/$acct" ] || { say "Konto $acct fehlt"; exit 1; }
fi
install -m 644 "$S/orderflow-binance-http.conf" /etc/nginx/conf.d/orderflow-binance.conf
install -m 644 "$S/orderflow-binance-headers.conf" /etc/nginx/snippets/orderflow-binance-headers.conf
install -m 644 "$S/orderflow-binance-proxy.conf" /etc/nginx/snippets/orderflow-binance-proxy.conf
install -d -m 755 /var/www/orderflow-acme

if [ ! -f "$CERT" ]; then
  say "Phase 1: nur Port 80 (ACME), Zertifikat holen"
  install -m 644 "$S/orderflow.rankyhub.com.bootstrap" "$SITE"
  ln -sfn "$SITE" "$LINK"
  nginx -t || undo
  systemctl reload nginx
  # Challenge-Pfad vorab prüfen (über die öffentliche Adresse, wie Let's Encrypt)
  install -d -m 755 /var/www/orderflow-acme/.well-known/acme-challenge
  probe=probe-$(openssl rand -hex 8)
  token=$(openssl rand -hex 16)
  printf %s "$token" > "/var/www/orderflow-acme/.well-known/acme-challenge/$probe" # ohne Zeilenende
  # Nach dem Reload übernehmen die neuen Worker erst nach kurzer Zeit: bis 15 Versuche à höchstens
  # 3 s + 1 s Pause (≤ 60 s). Verlangt wird der Inhalt der Probe-Datei, nicht nur Status 200, damit
  # kein anderer Server-Block durchrutscht (jede fehlgeschlagene LE-Validierung zählt gegen das Limit).
  code=000 got=
  for _ in $(seq 1 15); do
    got=$(curl -s --max-time 3 -w '\n%{http_code}' "http://orderflow.rankyhub.com/.well-known/acme-challenge/$probe" || true)
    code=${got##*$'\n'}
    [ "$code" = 200 ] && [ "${got%$'\n'*}" = "$token" ] && break
    sleep 1
  done
  rm -f "/var/www/orderflow-acme/.well-known/acme-challenge/$probe"
  if [ "$code" != 200 ] || [ "${got%$'\n'*}" != "$token" ]; then
    say "Challenge-Pfad liefert $code bzw. nicht die Probe-Datei – Abbruch vor certbot"
    say "Zustand: Bootstrap-Site (nur Port 80/ACME) bleibt aktiv; zurücknehmen mit nginx-setup.sh --rollback"
    rm -rf -- "$S" "$backup"
    exit 1
  fi
  # deploy-hook nur für diese Lineage (steht in renewal/orderflow.rankyhub.com.conf)
  certbot certonly --account "$acct" --webroot -w /var/www/orderflow-acme -d orderflow.rankyhub.com \
    --cert-name orderflow.rankyhub.com --non-interactive --keep-until-expiring \
    --deploy-hook 'nginx -t && systemctl reload nginx' </dev/null
fi

say "Phase 2: endgültige Site (80 → 308, 443 mit App und /api/)"
install -m 644 "$S/orderflow.rankyhub.com" "$SITE"
ln -sfn "$SITE" "$LINK"
nginx -t || undo
systemctl reload nginx
rm -rf -- "$S" "$backup"
sleep 1
for u in http://orderflow.rankyhub.com/ https://orderflow.rankyhub.com/ https://orderflow.rankyhub.com/api/v1/symbols https://orderflow.rankyhub.com/api/v1/health; do
  printf '[nginx] %s → %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u")" >&2
done
EOF
log "Prüfung von außen (Mac):"
for u in "http://$PUBLIC_HOST/" "https://$PUBLIC_HOST/" "https://$PUBLIC_HOST/api/v1/symbols" "https://$PUBLIC_HOST/api/v1/health"; do
  printf '  %s → %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$u")" >&2
done
log "erwartet: 308, 200, 200, 404"
