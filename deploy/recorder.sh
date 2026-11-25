#!/usr/bin/env bash
# Mac-Seite der Recorder-/Chunk-Wartung: ruft /opt/orderflow-binance/bin/recorder-ctl.sh auf dem
# Server auf (Unterbefehle und welche davon schreiben: siehe dort bzw. RUNBOOK.md).
#
#   deploy/recorder.sh [root@host] <unterbefehl> [args…]
#   deploy/recorder.sh [root@host] report <name>   → Prüfbericht nach $OF_RELEASE_DIR/state/report-<name>.txt
set -euo pipefail
. "$(dirname "$0")/lib.sh"
resolve_host "${1:-}"
[ "$SHIFTED" = 1 ] && shift
sub=${1:?Unterbefehl fehlt (prepare|hot|repair-dry|repair|require-zero|report|catchup|start|health|stop)}
shift
if [ "$sub" = report ]; then
  name=${1:?report braucht einen Namen, z. B. vor-reparatur}
  STATE="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}/state"
  mkdir -p "$STATE"
  out="$STATE/report-$name.txt"
  remote <<'EOF' > "$out"
set -euo pipefail
/opt/orderflow-binance/bin/recorder-ctl.sh report
EOF
  log "Prüfbericht → $out ($(wc -l < "$out") Zeilen)"
  grep -E '^(digest\||data_day\||info\|hot_compressed)' "$out" >&2
  exit 0
fi
remote "$sub" "$@" <<'EOF'
set -euo pipefail
/opt/orderflow-binance/bin/recorder-ctl.sh "$@"
EOF
