#!/usr/bin/env bash
# Baut ein Release auf dem Mac (nichts davon auf dem Server):
#   - aus einem sauberen Export des Commits HEAD (git archive), nie aus dem Arbeitsbaum: das Release
#     entspricht immer genau der in RELEASE notierten Commit-ID, auch wenn andere gerade im
#     Arbeitsbaum ändern (uncommittete Änderungen werden nur gemeldet, nicht mitgenommen)
#   - Web-Bundle (npm ci + npm run build -w @orderflow/web im Export)
#   - API-Image für linux/amd64 (deploy/api.Dockerfile, Kontext = Export), als gzip-Tar
#   - RELEASE (Metadaten) und SHA256SUMS
# Ausgabe: $OF_RELEASE_DIR/releases/<id>/ (Standard ~/.cache/orderflow-binance), nie ins Repo.
#
#   deploy/build-release.sh [<commit>]   → druckt die Release-ID als letzte Zeile (Standard HEAD)
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$REPO_DIR"

REV=$(git rev-parse --verify "${1:-HEAD}^{commit}")
SHA=$(git rev-parse --short=10 "$REV")
if [ -n "$(git status --porcelain -- apps packages package.json package-lock.json)" ]; then
  warn "Arbeitsbaum hat uncommittete Änderungen – sie gehören NICHT zum Release (Export von $SHA)"
fi
[ "$(node -v)" = "v$(git show "$REV:.nvmrc" | tr -d '[:space:]')" ] || die "Node $(node -v) ≠ .nvmrc des Commits (nvm use)"
ID="$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
BASE_DIR="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}"
OUT="$BASE_DIR/releases/$ID"
SRC="$BASE_DIR/build/$ID"
mkdir -p "$OUT" "$SRC"
log "Export $SHA → $SRC"
git archive --format=tar "$REV" | tar -x -C "$SRC"
cd "$SRC"

log "npm ci + Web-Bundle"
npm ci --no-audit --no-fund --ignore-scripts >&2
npm run build -w @orderflow/web >&2
[ -f apps/web/dist/index.html ] || die "apps/web/dist/index.html fehlt"
cp -R apps/web/dist "$OUT/web"
# Keine Quelldateien/Sourcemaps im Bundle
if find "$OUT/web" -name '*.map' -o -name '*.ts' | grep -q .; then warn "Bundle enthält .map/.ts-Dateien"; fi
rm -rf node_modules apps/*/node_modules packages/*/node_modules # Build-Kontext klein halten

log "API-Image linux/amd64 (orderflow-api:$ID)"
docker buildx build --platform linux/amd64 -f deploy/api.Dockerfile --build-arg "OF_RELEASE=$ID" \
  --provenance=false -t "orderflow-api:$ID" --load . >&2
# Kein .env im Image (Allowlist in api.Dockerfile.dockerignore) – Gegenprobe
if docker run --rm --platform linux/amd64 --entrypoint sh "orderflow-api:$ID" -c 'find / -xdev -name ".env*" 2>/dev/null | grep -v node_modules' | grep -q .; then
  die "Image enthält .env-Dateien"
fi
docker save "orderflow-api:$ID" | gzip -1 > "$OUT/api-image.tar.gz"

cat > "$OUT/RELEASE" <<EOF
id=$ID
git=$REV
built_utc=$(date -u +%FT%TZ)
node=$(cat .nvmrc)
migrations=$(find packages/db/migrations -name '*.up.sql' | sed 's#.*/##' | sort | tail -1)
web_bytes=$(du -sk "$OUT/web" | cut -f1)K
EOF
cd "$REPO_DIR" && rm -rf -- "$SRC"
sha256_manifest "$OUT"
log "Release $ID: $(du -sh "$OUT" | cut -f1) unter $OUT"
echo "$ID"
