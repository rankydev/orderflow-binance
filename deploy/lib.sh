# shellcheck shell=bash
# Gemeinsame Hilfen der Deploy-Skripte (auf dem Mac ausgeführt; macOS-bash 3.2 kompatibel).
# Ziel-Host: erstes Argument oder OF_DEPLOY_HOST aus der Umgebung bzw. aus deploy/.env.deploy
# (git-ignoriert, Vorlage deploy/env.deploy.example). Nie eine IP oder Secrets im Repo.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
# Feste Server-Pfade (siehe deploy/README.md, „Layout")
SRV_ROOT=/opt/orderflow-binance
SRV_ETC=/etc/orderflow-binance
SRV_VAR=/var/lib/orderflow-binance
SRV_COMPOSE="docker compose -p orderflow-binance -f $SRV_ROOT/compose.prod.yml --env-file $SRV_ROOT/.env"
PUBLIC_HOST=orderflow.rankyhub.com

log() { printf '\033[1m[%s] %s\033[0m\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
warn() { printf '\033[33m[%s] WARNUNG: %s\033[0m\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  printf '\033[31m[%s] FEHLER: %s\033[0m\n' "$(date -u +%H:%M:%S)" "$*" >&2
  exit 1
}

# Host bestimmen: $1 (falls user@host-artig) > OF_DEPLOY_HOST > deploy/.env.deploy
# Setzt DEPLOY_HOST und SHIFTED (1, wenn $1 verbraucht wurde).
resolve_host() {
  SHIFTED=0
  if [ -n "${1:-}" ] && [ "${1#-}" = "$1" ] && printf '%s' "$1" | grep -q '@'; then
    DEPLOY_HOST="$1"
    SHIFTED=1
    return
  fi
  if [ -z "${OF_DEPLOY_HOST:-}" ] && [ -f "$DEPLOY_DIR/.env.deploy" ]; then
    # shellcheck disable=SC1091
    . "$DEPLOY_DIR/.env.deploy"
  fi
  [ -n "${OF_DEPLOY_HOST:-}" ] || die "Ziel-Host fehlt: als erstes Argument (root@host) oder OF_DEPLOY_HOST in deploy/.env.deploy"
  DEPLOY_HOST="$OF_DEPLOY_HOST"
}

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=8)

# Befehl(e) auf dem Server per bash ausführen; Skripttext von stdin, Argumente als $1…
# Beispiel: remote <<'EOF' … EOF     bzw.  remote_args a b <<'EOF' … EOF
remote() {
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "bash -s -- $(printf '%q ' "$@")"
}

# Interaktive Bestätigung (überspringbar mit OF_YES=1, z. B. wenn der Nutzer den Lauf freigab)
confirm() {
  [ "${OF_YES:-0}" = 1 ] && return 0
  printf '%s [y/N] ' "$*" >&2
  read -r ans
  [ "$ans" = y ] || [ "$ans" = Y ] || die "abgebrochen"
}

sha256_manifest() { # $1 = Verzeichnis → schreibt SHA256SUMS (Format von sha256sum -c)
  (cd "$1" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS)
}
