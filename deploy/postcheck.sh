#!/usr/bin/env bash
# Nachprüfung (nur lesend): Nachbardienste unverändert gegenüber der Preflight-Baseline, und die
# eigene Site antwortet. Auch nach jedem Rollback-Schritt ausführen.
#
#   deploy/postcheck.sh [root@host] <baseline-datei> [--neighbours-only]
# Exit 0 = alles ok · 1 = Nachbardienste verändert oder Schnappschuss unvollständig (sofort
# handeln) · 3 = Nachbarn unverändert, aber die eigene Site noch nicht/nicht wie erwartet.
# --neighbours-only: nur die Nachbarn prüfen (nach Schritt 2–4, bevor die Site existiert).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
BASE=${1:?Baseline-Datei aus preflight.sh angeben}
ONLY=0
[ "${2:-}" = --neighbours-only ] && ONLY=1
NOW="${BASE%.txt}-after-$(date -u +%H%M%S).txt"

remote < "$DEPLOY_DIR/bin/server-snapshot.sh" > "$NOW" || die "Schnappschuss fehlgeschlagen"
snapshot_valid "$NOW" || die "Schnappschuss unvollständig ($NOW)"
for u in https://genius.rankyhub.com/ https://rankyhub.com/ https://takt.rankyhub.com/; do
  # Außensicht nur informativ: genius antwortet von außen schon vor dem Rollout teils erst nach
  # 6–20 s (von innen 10 ms) – als Pflichtvergleich ein Fehlalarm; maßgeblich sind site|/site6|
  printf 'info|external|%s|%s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}s' --max-time 30 "$u")" >> "$NOW"
done
if diff <(grep -v '^info|' "$BASE") <(grep -v '^info|' "$NOW"); then
  log "Nachbardienste unverändert (Units, Startzeiten, Container, pm2, Ports, Dateien, Statuscodes)"
else
  die "ABWEICHUNG bei den Nachbardiensten (siehe diff oben; $BASE ↔ $NOW)"
fi
[ "$ONLY" = 1 ] && exit 0

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
# Haltemarke des Recorders prüfen (recorder-ctl.sh stop bzw. release.sh schreiben sie): gültig nur,
# wenn der Container nicht läuft und spätestens 30 s nach der Marke beendet wurde (sonst lief er
# danach noch und starb von selbst). Ausgabe: "valid <Stunden>" | "stale" | "none".
stop_marker() { # $1 Container, $2 Markendatei
  [ -f "$2" ] || { echo none; return; }
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" != true ] || { echo stale; return; }
  python3 - "$(cat "$2")" "$(docker inspect -f '{{.State.FinishedAt}}' "$1" 2>/dev/null)" <<'PY'
import sys, re, datetime as dt
def p(x):
    # Docker liefert Nanosekunden (…:30.123456789Z); fromisoformat kann höchstens Mikrosekunden
    m = re.match(r'^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$', x.strip())
    if not m:
        raise ValueError(x)
    frac = (m.group(2) or '0')[:6].ljust(6, '0')
    tz = '+00:00' if m.group(3) == 'Z' else m.group(3)
    return dt.datetime.fromisoformat(m.group(1) + '.' + frac + tz)
try:
    m, f = p(sys.argv[1]), p(sys.argv[2])
except Exception:
    print('stale'); sys.exit()
now = dt.datetime.now(dt.timezone.utc)
print('valid %.1f' % ((now - m).total_seconds() / 3600) if f <= m + dt.timedelta(seconds=30) else 'stale')
PY
}
docker ps --filter name='^orderflow-' --format '  {{.Names}} {{.Status}} {{.Ports}}'
# Kein veröffentlichter Port von uns außerhalb von 127.0.0.1 (nur Einträge mit Host-Bindung „->")
pub=$(docker ps --filter name='^orderflow-' --format '{{.Ports}}' | tr ',' '\n' | sed 's/^ *//' | grep -- '->' || true)
[ -z "$(printf '%s\n' "$pub" | grep -v '^127\.0\.0\.1:' | grep -v '^$' || true)" ] || { echo "  Port außerhalb 127.0.0.1: $pub"; exit 1; }
# Erwartete eigene Container: db und api laufen; der Recorder nur, wenn er angelegt wurde – dann
# muss er laufen und healthy sein, und er veröffentlicht keinen Port
for c in orderflow-db orderflow-api; do
  [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ] || { echo "  $c läuft nicht"; exit 1; }
done
if docker inspect orderflow-recorder >/dev/null 2>&1; then
  st=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' orderflow-recorder)
  echo "  orderflow-recorder: $st"
  if [ "$st" != "running healthy" ]; then
    sm=$(stop_marker orderflow-recorder /opt/orderflow-binance/recorder.stopped)
    [ "${sm%% *}" = valid ] || { echo "  Recorder weder healthy noch gültig bewusst angehalten ($sm)"; exit 1; }
    echo "  Recorder bewusst angehalten (Marke gültig, ${sm#valid } h)"
  fi
  [ -z "$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' orderflow-recorder)" ] || { echo "  Recorder veröffentlicht einen Port"; exit 1; }
fi
# Recorder-Health/Ereignisse (7701) nur im Compose-Netz – auf dem Host lauscht niemand darauf
[ -z "$(ss -ltnH 'sport = :7701')" ] || { echo "  Port 7701 lauscht auf dem Host"; exit 1; }
# Produktionsmarker der Datenbank (install-server.sh, post-restore.sql) – fehlt er: harter Fehler
[ "$(docker exec orderflow-db psql -X -At -U of_admin -d orderflow -c "SELECT coalesce(shobj_description(oid, 'pg_database') LIKE '%orderflow:production%', false) FROM pg_database WHERE datname = 'orderflow'" </dev/null)" = t ] \
  || { echo "  Datenbank ohne Produktionsmarker orderflow:production"; exit 1; }
systemctl is-active orderflow-monitor.timer >/dev/null && journalctl -u orderflow-monitor.service -n 1 --no-pager -o cat || echo "  Monitor-Timer noch nicht aktiv"
EOF
if [ "$bad" != 0 ]; then
  warn "eigene Site nicht wie erwartet (Nachbarn unverändert)"
  exit 3
fi
log "Postcheck bestanden"
