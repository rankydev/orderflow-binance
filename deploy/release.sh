#!/usr/bin/env bash
# Rollt ein mit build-release.sh gebautes Release auf dem VPS aus bzw. zurück.
#
#   deploy/release.sh [root@host] <release-id>               ausrollen (nichts ausstehend)
#   deploy/release.sh [root@host] <release-id> --migrate 0013,0014,0015,0016
#        ausrollen und genau diese ausstehenden Migrationen anwenden (andere Menge → Abbruch)
#   deploy/release.sh [root@host] <release-id> --allow-pending-migrations 0013,0014
#        ausrollen, obwohl genau diese Migrationen ausstehen; es wird NICHTS migriert (für ein
#        Release, dessen API das alte Schema verträgt; nicht zusammen mit --migrate)
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
MIGRATE=
ROLLBACK=0
ALLOW=
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate)
      [ $# -ge 2 ] || die "--migrate braucht die erwartete Liste, z. B. 0013,0014,0015,0016"
      MIGRATE="$2"
      shift
      printf '%s' "$MIGRATE" | grep -qE '^[0-9]{4}(,[0-9]{4})*$' || die "Liste ungültig: $MIGRATE (Form 0013,0014)"
      ;;
    --rollback) ROLLBACK=1 ;;
    --allow-pending-migrations)
      [ $# -ge 2 ] || die "--allow-pending-migrations braucht eine Liste, z. B. 0013,0014"
      ALLOW="$2"
      shift
      printf '%s' "$ALLOW" | grep -qE '^[0-9]{4}(,[0-9]{4})*$' || die "Liste ungültig: $ALLOW (Form 0013,0014)"
      ;;
    -*) die "unbekanntes Argument: $1" ;;
    *) ID="$1" ;;
  esac
  shift
done
[ -z "$ALLOW" ] || [ -z "$MIGRATE" ] || die "--allow-pending-migrations und --migrate schließen sich aus"
[ -z "$MIGRATE" ] || [ "$ROLLBACK" = 0 ] || die "--migrate und --rollback schließen sich aus"
[ -z "$ALLOW" ] || [ "$ROLLBACK" = 0 ] || die "--allow-pending-migrations und --rollback schließen sich aus"

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

remote "$ID" "$MIGRATE" "$ROLLBACK" "$ALLOW" <<'EOF'
set -euo pipefail
ID=$1 MIGRATE=$2 ROLLBACK=$3 ALLOW=$4
R=/opt/orderflow-binance
C="docker compose -p orderflow-binance -f $R/compose.prod.yml --env-file $R/.env"
say() { printf '[release %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
PREV=$(sed -n 's/^OF_RELEASE=//p' "$R/.env")
dbq() { docker exec orderflow-db psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow -c "$1" </dev/null; }
# Produktionsmarker (install-server.sh / post-restore.sql); ohne ihn kein Release
marker_ok() { [ "$(dbq "SELECT coalesce(shobj_description(oid, 'pg_database') LIKE '%orderflow:production%', false) FROM pg_database WHERE datname = 'orderflow'")" = t ]; }
# Härtung ausführen und prüfen; ab Migration 0013 muss of_recorder CONNECT auf orderflow haben
harden_check() { # $1 = Bezeichnung (vor/nach den Migrationen)
  local h rec
  say "Härtung ($1): sql/harden-db.sql"
  h=$(docker exec -i orderflow-db psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow < "$R/sql/harden-db.sql")
  printf '%s\n' "$h" >&2
  rec=$(dbq "SELECT count(*) FROM schema_migrations WHERE version = '0013'")
  printf '%s\n' "$h" | grep -qx 'dbpriv|orderflow|of_api_connect=true|of_api_temp=false|of_api_create=false' \
    && ! printf '%s\n' "$h" | grep -E '^dbpriv\|' | grep -v '^dbpriv|orderflow|' | grep -q 'connect=true' \
    && ! printf '%s\n' "$h" | grep -q '_temp=true' \
    && ! printf '%s\n' "$h" | grep -q '_create=true' \
    && printf '%s\n' "$h" | grep -q '^public_connect|false|public_temp|false|' \
    && printf '%s\n' "$h" | grep -qx 'prodmarker|true' \
    && { [ "$rec" = 0 ] || printf '%s\n' "$h" | grep -qx 'dbpriv|orderflow|of_recorder_connect=true|of_recorder_temp=false|of_recorder_create=false'; } \
    || { say "Härtung ($1) nicht wie erwartet – Abbruch, API bleibt auf dem bisherigen Release"; exit 1; }
}
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
  marker_ok || { say "Datenbank ohne Produktionsmarker – zuerst deploy/install-server.sh (setzt ihn); Abbruch"; exit 1; }
  harden_check "vor den Migrationen"
  # Migrationsstand mit dem NEUEN Image prüfen (Migrationsdateien liegen im Image)
  # Das Skript kommt als Argument von bash -c (lib.sh remote), stdin der Gegenseite ist /dev/null.
  # Die </dev/null hier sind eine zweite Sicherung: `compose run` liest stdin und hatte, als das
  # Skript noch über stdin kam, dessen Rest verschluckt (beim Rollout so geschehen).
  st=$(OF_RELEASE=$ID $C run --rm -T ops node packages/db/src/cli.ts status </dev/null)
  printf '%s\n' "$st" >&2
  pending=$(printf '%s\n' "$st" | sed -n 's/^ausstehend *\([0-9]\{4\}\)_.*/\1/p' | sort | paste -sd, -)
  # jede „ausstehend"-Zeile muss eine erkannte Nummer liefern (sonst wäre die Liste unvollständig)
  n_lines=$(printf '%s\n' "$st" | grep -c '^ausstehend' || true)
  n_ids=$(printf '%s' "$pending" | tr ',' '\n' | grep -c . || true)
  [ "$n_lines" = "$n_ids" ] || { say "Migrationsstatus nicht lesbar ($n_lines ausstehend-Zeilen, $n_ids Nummern) – Abbruch"; exit 1; }
  if [ -n "$ALLOW" ]; then
    want=$(printf '%s' "$ALLOW" | tr ',' '\n' | sort | paste -sd, -)
    say "ausstehend: ${pending:-keine}; erlaubt (ohne Anwendung): $want"
    [ "$pending" = "$want" ] || { say "ausstehende Migrationen ≠ erlaubte Liste – Abbruch"; exit 1; }
  elif [ -n "$MIGRATE" ]; then
    want=$(printf '%s' "$MIGRATE" | tr ',' '\n' | sort | paste -sd, -)
    say "ausstehend: ${pending:-keine}; anzuwenden laut --migrate: $want"
    [ "$pending" = "$want" ] || { say "ausstehende Migrationen ≠ --migrate-Liste – Abbruch"; exit 1; }
    say "Migrationen anwenden"
    OF_RELEASE=$ID $C run --rm -T ops node packages/db/src/cli.ts up </dev/null
    # Härtung nach den Migrationen erneut (neue Rollen/Rechte, z. B. 0013 of_recorder)
    harden_check "nach den Migrationen"
  elif [ -n "$pending" ]; then
    say "ausstehende Migrationen ($pending) – erneut mit --migrate $pending (nach Prüfung)"; exit 1
  fi
  say "Passwort der Rolle of_api aus api.env setzen"
  OF_RELEASE=$ID $C run --rm -T ops node apps/api/src/cli/api-role-password.ts </dev/null
  # Rolle of_recorder (ab 0013): Passwort aus recorder.env mit dem Werkzeug des Recorders
  # (e938c31, sendet nur den SCRAM-Verifier).
  # Ab Migration 0013 (Schema) ist das Passwort Pflicht: fehlen recorder.env oder das Werkzeug → Abbruch
  if [ "$(dbq "SELECT count(*) FROM schema_migrations WHERE version = '0013'")" = 1 ]; then
    [ -f /etc/orderflow-binance/recorder.env ] || { say "recorder.env fehlt – zuerst deploy/install-server.sh; Abbruch"; exit 1; }
    OF_RELEASE=$ID $C run --rm -T ops test -f apps/recorder/src/cli/recorder-role-password.ts </dev/null \
      || { say "Release enthält recorder-role-password nicht, Schema ist ab 0013 – Abbruch"; exit 1; }
    say "Passwort der Rolle of_recorder aus recorder.env setzen"
    OF_RELEASE=$ID $C run --rm -T ops node apps/recorder/src/cli/recorder-role-password.ts </dev/null
  fi
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
# Läuft der Recorder bereits, bekommt er dasselbe Release (startet neu: Spool + REST ab letzter ID).
# Gestartet wird er hier nie erstmals – das ist recorder.sh start. Enthält das Ziel-Image keinen
# Recorder (z. B. Rollback auf ein älteres Release), wird er geordnet angehalten statt in eine
# Neustartschleife zu laufen.
if [ "$(docker inspect -f '{{.State.Running}}' orderflow-recorder 2>/dev/null)" = true ]; then
  if docker run --rm --entrypoint test "orderflow-api:$ID" -f apps/recorder/src/main.ts </dev/null; then
    say "Recorder läuft – auf $ID umstellen"
    $C --profile recorder up -d recorder </dev/null
    rst=missing
    for _ in $(seq 1 60); do # ≤ 10 min: Spool-Wiedergabe + REST ab der letzten ID
      rst=$(docker inspect -f '{{.State.Health.Status}}' orderflow-recorder 2>/dev/null || echo missing)
      [ "$rst" = healthy ] && break
      sleep 10
    done
    [ "$rst" = healthy ] || { say "!!! Recorder nach dem Umstellen auf $ID nicht healthy (Status $rst) – Logs prüfen; API/Web sind umgestellt"; exit 1; }
    say "Recorder healthy auf $ID"
  else
    say "!!! Release $ID enthält keinen Recorder – Recorder wird ANGEHALTEN (keine Live-Daten, bis ein Release mit Recorder läuft)"
    $C --profile recorder stop recorder </dev/null
    date -u +%FT%TZ > "$R/recorder.stopped"
  fi
fi
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
