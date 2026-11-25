#!/usr/bin/env bash
# Nur lesender Schnappschuss der Nachbardienste auf dem VPS (von preflight.sh und postcheck.sh per
# `remote` als Argument von bash -c ausgeführt, stdin der Gegenseite /dev/null; nie installiert). Ausgabe: stabile Zeilen „schlüssel|wert";
# vor und nach dem Rollout identisch, solange nichts an den Nachbarn verändert/neu gestartet wurde.
# Zeilen mit Präfix „info|" sind informativ (dürfen sich ändern).
set -uo pipefail

# systemd-Dienste: Zustand + Startzeitpunkt (ändert sich bei jedem Neustart) + Restart-Zähler
for u in nginx.service docker.service containerd.service takt-backend.service mongod.service pm2-root.service; do
  printf 'unit|%s|%s\n' "$u" "$(systemctl show "$u" -p ActiveState -p SubState -p ActiveEnterTimestampMonotonic -p NRestarts --value | tr '\n' ' ')"
done
# nginx-Master-PID (Reload behält ihn; Neustart nicht)
printf 'nginx|master_pid|%s\n' "$(cat /run/nginx.pid 2>/dev/null)"
printf 'info|nginx|workers|%s\n' "$(pgrep -c -P "$(cat /run/nginx.pid 2>/dev/null)" 2>/dev/null)"

# Docker-Container der Nachbarn (alle außer orderflow-*)
docker ps -a --format '{{.Names}}' | grep -v '^orderflow-' | sort | while read -r c; do
  printf 'container|%s|%s\n' "$c" "$(docker inspect -f '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{end}} started={{.State.StartedAt}} restarts={{.RestartCount}} image={{.Image}}' "$c")"
done
docker network ls --format '{{.Name}}' | grep -v '^orderflow-' | sort | sed 's/^/network|/'
docker volume ls --format '{{.Name}}' | grep -v '^orderflow-' | sort | sed 's/^/volume|/'

# pm2-Prozesse (PulseBot): Status, Startzeit, Neustarts. Der Daemon läuft als root mit
# PM2_HOME=/root/.pm2 (pm2-root.service). pm2 nur fragen, wenn genau dieser Daemon lebt – ein
# pm2-Aufruf ohne laufenden Daemon würde sonst einen neuen starten (Seiteneffekt).
PM2_HOME=/root/.pm2
if [ -s "$PM2_HOME/pm2.pid" ] && kill -0 "$(cat "$PM2_HOME/pm2.pid")" 2>/dev/null \
   && [ "$(ps -o user= -p "$(cat "$PM2_HOME/pm2.pid")")" = root ]; then
  PM2_HOME=$PM2_HOME pm2 jlist 2>/dev/null | python3 -c '
import json, sys
for p in sorted(json.load(sys.stdin), key=lambda p: p["name"]):
    e = p["pm2_env"]
    print("pm2|%s|%s|started=%s|restarts=%s" % (p["name"], e.get("status"), e.get("pm_uptime"), e.get("restart_time")))
' || echo "pm2|jlist-failed"
else
  echo "pm2|daemon-missing"
fi

# Lauschende Ports (ohne PIDs; nginx/docker-proxy-PIDs bleiben durch Reload gleich, sind aber Rauschen)
ss -ltnH | awk '{print $4}' | sort -u | grep -vE ':(8780|54320)$' | sed 's/^/port|/'

# Dateien der Nachbarn, die nie verändert werden dürfen: Prüfsummen
for f in /etc/nginx/nginx.conf /etc/nginx/sites-available/* /etc/nginx/conf.d/* /etc/nginx/snippets/* \
         /etc/letsencrypt/options-ssl-nginx.conf /etc/letsencrypt/renewal/*.conf \
         /etc/letsencrypt/renewal-hooks/*/* /etc/docker/daemon.json /etc/systemd/journald.conf \
         /etc/systemd/system/takt-backend.service /etc/systemd/system/pm2-root.service; do
  [ -e "$f" ] || continue
  case "$f" in
    *orderflow*) continue ;; # eigene Dateien
  esac
  printf 'file|%s|%s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
done
ls -1 /etc/nginx/sites-enabled | grep -vE '^(zz-)?orderflow' | sed 's/^/enabled|/'
ls -1 /opt | grep -v '^orderflow' | sed 's/^/opt|/'
# listen-Zeilen aller Nachbar-Server (Socket-Optionen bestimmen Standardserver und HTTP/2)
nginx -T 2>/dev/null | awk '/^# configuration file /{f=$4} /^[ \t]*listen/{ if (f !~ /orderflow/) { gsub(/^[ \t]+|[ \t]+$/, ""); print "listen|" f "|" $0 } }'
certbot certificates 2>/dev/null | awk '/Certificate Name:/{n=$3} /Expiry Date:/{print "cert|" n "|" $3}' | grep -v '|orderflow'

# Erreichbarkeit der vorhandenen Sites vom Server selbst (über nginx, ohne DNS-Abhängigkeit)
for h in genius.rankyhub.com rankyhub.com takt.rankyhub.com; do
  for s in http https; do
    port=80
    [ "$s" = https ] && port=443
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$h:$port:127.0.0.1" "$s://$h/")
    printf 'site|%s://%s/|%s\n' "$s" "$h" "$code"
  done
done
# Standardserver für unbekannte Hostnamen (darf sich durch uns nicht ändern)
# (IPv4 und IPv6 getrennt: Standardserver gelten je Socket)
for a in 127.0.0.1 '[::1]'; do
  printf 'default|http|%s|%s\n' "$a" "$(curl -sk -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 -H 'Host: unknown.invalid' "http://$a/")"
  printf 'default|https-sni|%s|%s\n' "$a" "$(echo | openssl s_client -connect "$a:443" -servername unknown.invalid 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)"
  printf 'default|https-nosni|%s|%s\n' "$a" "$(echo | openssl s_client -connect "$a:443" -noservername 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)"
done
for h in genius.rankyhub.com rankyhub.com takt.rankyhub.com; do
  printf 'site6|https://%s/|%s\n' "$h" "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$h:443:[::1]" "https://$h/")"
done

# Informativ
printf 'info|mem_available_mb|%s\n' "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
printf 'info|disk_free_gb|%s\n' "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
printf 'info|load|%s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
echo "snapshot|complete"
