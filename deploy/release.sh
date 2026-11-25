#!/usr/bin/env bash
# Rollt ein mit build-release.sh gebautes Release auf dem VPS aus bzw. zurück.
#
#   deploy/release.sh [root@host] <release-id> [--migrate]   ausrollen
#   deploy/release.sh [root@host] --rollback                  auf das vorige Release zurück
#
# Ablauf: Upload nach /opt/orderflow-binance/releases/<id>/ → sha256sum -c → docker load →
# Migrationsstand prüfen (ausstehende Migrationen nur mit --migrate) → Passwort der API-Rolle aus
# api.env setzen → .env (OF_RELEASE) umstellen → API neu starten und auf „healthy" warten
# (sonst automatisch zurück auf das vorige Release) → Symlink current atomar umstellen (Web) →
# Rauchtest → alte Releases aufräumen (die letzten 3 bleiben).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
ID=
MIGRATE=0
ROLLBACK=0
for a in "$@"; do
  case "$a" in
    --migrate) MIGRATE=1 ;;
    --rollback) ROLLBACK=1 ;;
    -*) die "unbekanntes Argument: $a" ;;
    *) ID="$a" ;;
  esac
done

if [ "$ROLLBACK" = 0 ]; then
  [ -n "$ID" ] || die "Release-ID fehlt (Ausgabe von deploy/build-release.sh)"
  SRC="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}/releases/$ID"
  [ -f "$SRC/SHA256SUMS" ] || die "kein Release unter $SRC"
  (cd "$SRC" && shasum -a 256 -c --quiet SHA256SUMS) || die "lokale Prüfsummen falsch"
  log "Upload $ID"
  remote "$SRV_ROOT/releases/$ID" <<'EOF'
set -euo pipefail
mkdir -p "$1"
EOF
  rsync -a --partial -e "ssh ${SSH_OPTS[*]}" "$SRC/" "$DEPLOY_HOST:$SRV_ROOT/releases/$ID/"
fi

remote "$ID" "$MIGRATE" "$ROLLBACK" <<'EOF'
set -euo pipefail
ID=$1 MIGRATE=$2 ROLLBACK=$3
R=/opt/orderflow-binance
C="docker compose -p orderflow-binance -f $R/compose.prod.yml --env-file $R/.env"
say() { printf '[release %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
PREV=$(sed -n 's/^OF_RELEASE=//p' "$R/.env")
cd "$R/releases"

if [ "$ROLLBACK" = 1 ]; then
  ID=$(ls -1 | grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$' | sort | awk -v cur="$PREV" '$0 < cur' | tail -1)
  [ -n "$ID" ] || { say "kein älteres Release vorhanden"; exit 1; }
  docker image inspect "orderflow-api:$ID" >/dev/null || { say "Image orderflow-api:$ID fehlt"; exit 1; }
  say "Rollback $PREV → $ID"
else
  cd "$ID"
  sha256sum --quiet -c SHA256SUMS
  say "Prüfsummen ok; docker load"
  gunzip -c api-image.tar.gz | docker load -q
  rm -f api-image.tar.gz
  cd ..
  # Migrationsstand mit dem NEUEN Image prüfen (Migrationsdateien liegen im Image)
  # </dev/null überall: dieses Skript kommt per stdin (bash -s); `compose run` läse sonst den Rest
  # des Skripts als Eingabe des Containers und die folgenden Befehle liefen nie (so geschehen)
  st=$(OF_RELEASE=$ID $C run --rm -T ops node packages/db/src/cli.ts status </dev/null)
  printf '%s\n' "$st" >&2
  if printf '%s\n' "$st" | grep -q '^ausstehend'; then
    if [ "$MIGRATE" != 1 ]; then say "ausstehende Migrationen – erneut mit --migrate (nach Prüfung)"; exit 1; fi
    say "Migrationen anwenden"
    OF_RELEASE=$ID $C run --rm -T ops node packages/db/src/cli.ts up </dev/null
  fi
  say "Passwort der Rolle of_api aus api.env setzen"
  OF_RELEASE=$ID $C run --rm -T ops node apps/api/src/cli/api-role-password.ts </dev/null
fi

printf 'OF_RELEASE=%s\n' "$ID" > "$R/.env.new" && mv -f "$R/.env.new" "$R/.env"
if ! $C up -d --wait --wait-timeout 120 api </dev/null; then
  say "API $ID nicht healthy – Logs:"
  docker logs --tail 30 orderflow-api >&2 || true
  if [ -n "$PREV" ] && [ "$PREV" != none ]; then
    say "zurück auf $PREV"
    printf 'OF_RELEASE=%s\n' "$PREV" > "$R/.env"
    $C up -d --wait --wait-timeout 120 api </dev/null || true
  else
    $C stop api </dev/null || true
  fi
  exit 1
fi
ln -sfn "releases/$ID" "$R/current.new" && mv -Tf "$R/current.new" "$R/current"
say "current → $(readlink "$R/current")"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8780/api/v1/symbols)
[ "$code" = 200 ] || { say "Rauchtest /api/v1/symbols: $code"; exit 1; }
if [ -e /etc/nginx/sites-enabled/zz-orderflow.rankyhub.com ]; then
  for p in / /api/v1/symbols; do
    printf '[release] https://orderflow.rankyhub.com%s → %s\n' "$p" "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve orderflow.rankyhub.com:443:127.0.0.1 "https://orderflow.rankyhub.com$p")" >&2
  done
fi

# Aufräumen: letzte 3 Release-Verzeichnisse und ihre Images behalten (nie das laufende)
keep=$(ls -1 | grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$' | sort | tail -3)
for d in $(ls -1 | grep -E '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$'); do
  if ! printf '%s\n' "$keep" | grep -qx "$d" && [ "$d" != "$ID" ]; then
    rm -rf -- "$R/releases/$d"
    docker image rm "orderflow-api:$d" >/dev/null 2>&1 || true
    say "entfernt: $d"
  fi
done
say "Release $ID aktiv"
EOF
log "fertig"
