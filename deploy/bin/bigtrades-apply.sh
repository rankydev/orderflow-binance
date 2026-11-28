#!/usr/bin/env bash
# Big-Trades-Ergänzung auf dem Ziel prüfen/einspielen/zurücknehmen (läuft auf dem VPS aus dem
# Transferverzeichnis, von deploy/transfer-bigtrades.sh dorthin kopiert; lokal in den Tests gegen
# Wegwerf-DBs).
#
#   bigtrades-apply.sh <verzeichnis> <dry-run|apply|verify|revert> [--ignore-window] [--lock-wait S]
#
# <verzeichnis> enthält payload.sql.gz (bigtrades-export.sql), bigtrades-stage.sql, bigtrades-run.sql,
# für revert zusätzlich revert.tsv (Name<TAB>Tag je Zeile: die Tage mit „ok“ eines früheren Laufs).
# Eine psql-Sitzung als of_admin (docker exec, wie recorder-ctl.sh): Staging-Tabellen (temporär) →
# Nutzlast → Modus. Zeilenausgabe fortlaufend auf stdout, Zusammenfassung auf stderr, zuletzt
# „ergebnis|exit=<n>|…“.
# Exit (Vorrang in dieser Reihenfolge):
#   3 Abbruch (ABBRUCH: … bzw. Sitzung beendet; festgeschriebene Tage bleiben gültig)
#   1 fail (Gegenprobe gescheitert, Tag zurückgerollt) bzw. verify-Abweichung – nicht übergehen
#   4 Chunks teilweise komprimiert geblieben (erneut ausführen)
#   6 busy: Tage vorübergehend gesperrt, unverändert (erneut ausführen)
#   2 skip: Tage passen dauerhaft nicht, unverändert (Gründe einmal prüfen; Wiederholung ändert nichts)
#   0 alles übertragen/identisch
# Umgebung: OF_DB_CONTAINER (orderflow-db), OF_BT_DB (orderflow). Nur Tests: OF_BT_ABORT_AFTER,
# OF_BT_NOW.
set -euo pipefail
dir=${1:?Verzeichnis fehlt}
mode=${2:?Modus fehlt (dry-run|apply|verify|revert)}
shift 2
case "$mode" in dry-run | apply | verify | revert) ;; *) echo "unbekannter Modus: $mode" >&2; exit 3 ;; esac
IGN=0
WAIT=120
while [ $# -gt 0 ]; do
  case "$1" in
    --ignore-window) IGN=1 ;;
    --lock-wait) WAIT=${2:?}; shift ;;
    *) echo "unbekanntes Argument: $1" >&2; exit 3 ;;
  esac
  shift
done
printf '%s' "$WAIT" | grep -qE '^[0-9]+$' || { echo "--lock-wait: ganze Sekunden" >&2; exit 3; }
DBC=${OF_DB_CONTAINER:-orderflow-db}
DBN=${OF_BT_DB:-orderflow}
for f in payload.sql.gz bigtrades-stage.sql bigtrades-run.sql; do
  [ -f "$dir/$f" ] || { echo "fehlt: $dir/$f" >&2; exit 3; }
done
if [ "$mode" = revert ]; then
  [ -s "$dir/revert.tsv" ] || { echo "revert: $dir/revert.tsv fehlt oder ist leer" >&2; exit 3; }
  if grep -qvE '^[A-Z0-9]+	[0-9]{4}-[0-9]{2}-[0-9]{2}$' "$dir/revert.tsv"; then
    echo "revert.tsv: Zeilen Name<TAB>YYYY-MM-DD" >&2
    exit 3
  fi
fi
tmp=$(mktemp -d)
out="$tmp/out"
: > "$out"
# Fällt der Aufrufer weg (Strg-C/SSH-Abbruch: tee bekommt EPIPE, bzw. HUP/INT/TERM), liefe die
# Sitzung im Container weiter (docker exec beendet den Prozess drinnen nicht) und hielte den
# Importer-Lock. Daher am Ende immer die eigene Sitzung beenden, falls sie noch lebt: der laufende
# Tag wird zurückgerollt, Lock und temporäre Tabellen verschwinden.
stop_session() {
  local pid
  pid=$(sed -n 's/^info|backend|//p' "$out" 2>/dev/null | head -1)
  printf '%s' "$pid" | grep -qE '^[0-9]+$' || return 0
  docker exec "$DBC" psql -X -At -q -U of_admin -d "$DBN" -c \
    "SELECT pg_terminate_backend($pid) FROM pg_stat_activity WHERE pid = $pid AND application_name = 'orderflow-bigtrades'" \
    </dev/null >/dev/null 2>&1 || true
}
trap 'stop_session; rm -rf "$tmp"' EXIT
trap 'exit 3' HUP INT TERM PIPE
t0=$(date +%s)
# Im Hintergrund + wait: nur so laufen die Signal-Fallen sofort (bash stellt sie sonst bis zum Ende
# der Vordergrund-Pipeline zurück). psql-Exit über eine Datei, tee-Exit über wait.
set +e
{
  cat "$dir/bigtrades-stage.sql"
  gzip -dc "$dir/payload.sql.gz"
  if [ "$mode" = revert ]; then
    printf 'COPY bt_revert (name, day) FROM STDIN;\n'
    cat "$dir/revert.tsv"
    printf '\\.\n'
  fi
  cat "$dir/bigtrades-run.sql"
} | {
  docker exec -i "$DBC" psql -X -At -q -v ON_ERROR_STOP=1 -v mode="$mode" -v ignore_window="$IGN" \
    -v lock_wait="$WAIT" -v abort_after="${OF_BT_ABORT_AFTER:-0}" -v now_override="${OF_BT_NOW:-}" \
    -U of_admin -d "$DBN"
  echo $? > "$tmp/rc"
} | tee "$out" &
wait $!
tee_rc=$?
set -e
[ "$tee_rc" = 0 ] || exit 3 # Ausgabe weg (Aufrufer beendet): Sitzung beenden (EXIT-Falle)
rc=$(cat "$tmp/rc" 2>/dev/null || echo 3)
cnt() { grep -c -- "$1" "$out" || true; } # Grundmuster (BRE): | ist ein Zeichen
v() { cnt "^day|[^|]*|[^|]*|$1|"; }
el=$(( $(date +%s) - t0 ))
if [ "$mode" = verify ]; then
  n=$(cnt '^verify|')
  ok=$(cnt '^verify|.*|match$')
  busy=$(cnt '^verify|.*|busy$')
  fail=$(( n - ok - busy ))
  skip=0
  echo "verify: $ok/$n Tage v2 identisch, $fail abweichend, $busy busy, ${el} s" >&2
  grep '^verify|' "$out" | grep -v '|match$' >&2 || true
else
  fail=$(v fail)
  skip=$(v skip)
  busy=$(v busy)
  printf '%s: Tage=%s ok=%s would=%s same=%s reverted=%s skip=%s fail=%s busy=%s, %s s\n' "$mode" \
    "$(cnt '^day|')" "$(v ok)" "$(v would)" "$(v same)" "$(v reverted)" "$skip" "$fail" "$busy" "$el" >&2
  grep -E '^day\|[^|]*\|[^|]*\|(skip|fail|busy)\|' "$out" >&2 || true
fi
grep -E '^(floor|check|partial_chunks|hot_compressed_chunks)\|' "$out" >&2 || true
grep -E '^chunk\|.*\|deferred\|' "$out" >&2 || true
partial=$(sed -n 's/^partial_chunks|//p' "$out")
code=0
if [ "$rc" != 0 ] || [ -z "$partial" ]; then
  echo "psql beendet mit $rc (Abbruch; festgeschriebene Tage sind vollständig, offene zurückgerollt)" >&2
  code=3
elif [ "$fail" != 0 ]; then
  code=1
elif { [ "$mode" = apply ] || [ "$mode" = revert ]; } && [ "$partial" != 0 ]; then
  echo "$partial Chunks teilweise komprimiert – erneut ausführen (idempotent)" >&2
  code=4
elif [ "$busy" != 0 ]; then
  code=6
elif [ "$skip" != 0 ]; then
  code=2
fi
echo "ergebnis|exit=$code|fail=$fail|busy=$busy|skip=$skip|partial_chunks=${partial:-?}" >&2
exit "$code"
