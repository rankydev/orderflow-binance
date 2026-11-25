#!/usr/bin/env bash
# Recorder- und Chunk-Wartung auf dem VPS (installiert unter /opt/orderflow-binance/bin/, vom Mac
# über deploy/recorder.sh aufgerufen). Jeder Unterbefehl ist genau eine Handlung; die schreibenden
# sind markiert (= je eine Freigabe im Rollout).
#
#   prepare        [schreibt] Datenverzeichnis /var/lib/orderflow-binance/data (UID 10001) und die
#                  Rohdaten-Cache-Markierung anlegen (Voraussetzung für OF_RAW_KEEP_DAYS > 0)
#   hot            [liest]    offene komprimierte Chunks auflisten (sql/hot-chunks.sql)
#   repair-dry     [liest]    importer repair-open-chunks --dry-run
#   repair         [schreibt] importer repair-open-chunks --lock-timeout-ms 500 (Rowstore-Wandlung
#                             offener Chunks; nie parallel zu Transfer oder Prüfbericht)
#   require-zero   [liest]    Probelauf meldet 0 und hot-chunks --require-zero
#   report         [liest]    Prüfbericht (sql/verify-db.sql) nach stdout
#   catchup-range FROM TO
#                  [schreibt] Tage FROM…TO (UTC, YYYY-MM-DD) für BTCUSDT und ETHUSDT laden (aggTrades,
#                             Klines) und importieren (--db --online) – vor dem ersten Recorder-Start
#                             bis einschließlich gestern
#   catchup ARGS…  [schreibt] Importer mit beliebigen ARGS im importer-Container (Einzelfälle)
#   start [MIN]    [schreibt] Recorder starten und bis „healthy" warten (Standard ≤ 150 min:
#                             REST-Nachholen seit dem letzten Trade beider Symbole; gemessen ≈ 7
#                             Daten-Minuten je Symbol und Minute bei 600 Gewicht → 8 h ≈ 70 min)
#   health         [liest]    Health des Recorders (Auszug)
#   stop           [schreibt] Recorder anhalten (Rücknahme; Container und Daten bleiben)
#
# Pfade/Namen für lokale Tests überschreibbar: OF_ROOT, OF_DATA, OF_COMPOSE, OF_DB_CONTAINER,
# OF_REC_CONTAINER.
set -euo pipefail
R=${OF_ROOT:-/opt/orderflow-binance}
DATA=${OF_DATA:-/var/lib/orderflow-binance/data}
C=${OF_COMPOSE:-docker compose -p orderflow-binance -f $R/compose.prod.yml --env-file $R/.env}
DBC=${OF_DB_CONTAINER:-orderflow-db}
RECC=${OF_REC_CONTAINER:-orderflow-recorder}
OWN=${OF_DATA_OWNER-10001:10001} # leer = Eigentümer nicht setzen (lokaler Test ohne root)
say() { printf '[recorder-ctl %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
psql_admin() { docker exec -i "$DBC" psql -X -At -v ON_ERROR_STOP=1 -U of_admin -d orderflow "$@"; }
rec_health() {
  docker exec "$RECC" node -e "fetch('http://127.0.0.1:7701/health').then(async r=>{const j=await r.json();const s={};for(const[k,v]of Object.entries(j.symbols||{}))s[k]={lastTradeAgeMs:v.lastTradeAgeMs,unwrittenMinutes:v.unwrittenMinutes,gapOpen:v.gapOpen,lastCommittedMinute:v.lastCommittedMinute,lastFinalisedDay:v.lastFinalisedDay,eventLagMs:v.eventLagMs};console.log(JSON.stringify({status:r.status,healthy:j.healthy,wsConnected:j.wsConnected,spoolEnabled:j.spoolEnabled,hotCompressedChunks:j.hotCompressedChunks,partialChunks:j.partialChunks,partialChunkAlert:j.partialChunkAlert,postCommitErrors:j.postCommitErrors,dbWriteErrors:j.dbWriteErrors,rssMb:j.rssMb,symbols:s}))},e=>{console.log(JSON.stringify({status:0,error:String(e)}));process.exit(1)})" </dev/null
}
# Laufende Prüfberichte, Dumps oder Restores (Sitzungen von of_admin außer unserer), die eine
# Rowstore-Wandlung mit einem älteren Snapshot leer sähen → Reparatur verweigern.
guard_no_snapshot_readers() {
  local n
  n=$(psql_admin -c "SELECT count(*) FROM pg_stat_activity
                       WHERE datname = 'orderflow' AND pid <> pg_backend_pid()
                         AND backend_type = 'client backend'
                         AND (application_name IN ('psql', 'pg_dump', 'pg_restore', 'vacuumdb')
                              OR (usename = 'of_admin' AND application_name NOT LIKE 'orderflow-%'))
                         AND state <> 'idle'" </dev/null)
  [ "$n" = 0 ] || { say "$n laufende Admin-/psql-/Dump-Sitzung(en) auf orderflow – Reparatur verweigert (nie parallel zu Transfer/Prüfbericht)"; exit 1; }
}
importer() { $C run --rm -T importer node apps/importer/src/main.ts "$@" </dev/null; }
# Keine offenen komprimierten Chunks: Probelauf der Reparatur meldet 0 und hot-chunks --require-zero
require_zero() {
  local out
  out=$(importer repair-open-chunks --dry-run)
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -q 'repair-open-chunks: 0 Chunks gefunden' || { say "Probelauf meldet nicht 0"; exit 1; }
  OF_HOT_SQL="$R/sql/hot-chunks.sql" OF_DB_CONTAINER="$DBC" "$R/bin/hot-chunks.sh" --require-zero
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  prepare)
    [ -f /etc/orderflow-binance/recorder.env ] || [ -n "${OF_ROOT:-}" ] || { say "recorder.env fehlt – zuerst install-server.sh"; exit 1; }
    install -d -m 750 "$DATA" "$DATA/raw" "$DATA/raw/binance-vision" "$DATA/live"
    [ -z "$OWN" ] || chown "$OWN" "$DATA" "$DATA/raw" "$DATA/raw/binance-vision" "$DATA/live"
    if find "$DATA/raw/binance-vision" -path '*monthly*' -print -quit | grep -q .; then
      say "Monatsdateien unter $DATA/raw/binance-vision – Markierung NICHT angelegt"; exit 1
    fi
    m="$DATA/raw/binance-vision/.of-recorder-raw-cache"
    if [ ! -f "$m" ]; then : > "$m"; chmod 640 "$m"; [ -z "$OWN" ] || chown "$OWN" "$m"; fi
    say "Datenverzeichnis bereit: $(ls -ldn "$DATA" | awk '{print $1, $3":"$4}'), Markierung vorhanden"
    ;;
  hot) OF_HOT_SQL="$R/sql/hot-chunks.sql" OF_DB_CONTAINER="$DBC" "$R/bin/hot-chunks.sh" ;;
  repair-dry) importer repair-open-chunks --dry-run ;;
  repair)
    guard_no_snapshot_readers
    importer repair-open-chunks --lock-timeout-ms 500
    ;;
  require-zero) require_zero ;;
  report) psql_admin < "$R/sql/verify-db.sql" ;;
  catchup)
    [ $# -gt 0 ] || { say "catchup braucht Importer-Argumente"; exit 2; }
    importer "$@"
    ;;
  catchup-range)
    from=${1:-} to=${2:-}
    printf '%s\n%s\n' "$from" "$to" | grep -qvE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' && { say "catchup-range FROM TO (YYYY-MM-DD)"; exit 2; }
    [ "$(date -u +%F)" \> "$to" ] || { say "TO muss vor heute (UTC) liegen – heutige Daten holt der Recorder"; exit 2; }
    for sym in ${OF_SYMBOLS:-BTCUSDT ETHUSDT}; do
      for kind in aggTrades klines; do
        importer download --symbol "$sym" --kind "$kind" --from "$from" --to "$to"
      done
      importer import --symbol "$sym" --from "$from" --to "$to" --db --online
    done
    ;;
  start)
    [ -d "$DATA/live" ] || { say "zuerst prepare"; exit 1; }
    wait_min=${1:-150}
    printf '%s' "$wait_min" | grep -qE '^[0-9]+$' && [ "$wait_min" -ge 1 ] || { say "start [MIN]: MIN muss eine ganze Zahl ≥ 1 sein"; exit 2; }
    say "Vorbedingung: keine offenen komprimierten Chunks"
    require_zero
    rm -f "$R/recorder.stopped"
    $C --profile recorder up -d recorder </dev/null
    for _ in $(seq 1 $(( wait_min * 6 ))); do
      st=$(docker inspect -f '{{.State.Health.Status}}' "$RECC" 2>/dev/null || echo missing)
      [ "$st" = healthy ] && break
      [ "$(docker inspect -f '{{.State.Running}}' "$RECC" 2>/dev/null)" = true ] || { say "Recorder läuft nicht"; docker logs --tail 30 "$RECC" >&2; exit 1; }
      sleep 10
      [ $(( $(date +%s) % 300 )) -lt 10 ] && rec_health || true
    done
    rec_health || true
    [ "$st" = healthy ] || { say "Recorder nach $wait_min min nicht healthy (Status $st) – Health/Logs prüfen; er läuft weiter"; exit 1; }
    say "Recorder healthy"
    ;;
  health) rec_health ;;
  stop)
    $C --profile recorder stop recorder </dev/null
    # bewusst angehalten: der Monitor meldet das als Hinweis statt als Alarm (start entfernt es)
    date -u +%FT%TZ > "$R/recorder.stopped"
    say "Recorder angehalten: $(docker inspect -f '{{.State.Status}}' "$RECC" 2>/dev/null || echo fehlt)"
    ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d' >&2; exit 2 ;;
esac
