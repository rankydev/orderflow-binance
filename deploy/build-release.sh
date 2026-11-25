#!/usr/bin/env bash
# Baut ein Release auf dem Mac (nichts davon auf dem Server):
#   - Web-Bundle (npm run build -w @orderflow/web → apps/web/dist)
#   - API-Image für linux/amd64 (deploy/api.Dockerfile), als gzip-Tar für `docker load`
#   - RELEASE (Metadaten) und SHA256SUMS
# Ausgabe: $OF_RELEASE_DIR/releases/<id>/ (Standard ~/.cache/orderflow-binance), nie ins Repo.
#
#   deploy/build-release.sh            → druckt die Release-ID als letzte Zeile
# Verweigert einen unsauberen Arbeitsbaum in apps/ packages/ (OF_ALLOW_DIRTY=1 übersteuert).
set -euo pipefail
. "$(dirname "$0")/lib.sh"
cd "$REPO_DIR"

if [ -n "$(git status --porcelain -- apps packages package.json package-lock.json)" ]; then
  [ "${OF_ALLOW_DIRTY:-0}" = 1 ] || die "uncommittete Änderungen in apps/ oder packages/ – erst committen (oder OF_ALLOW_DIRTY=1)"
  warn "unsauberer Arbeitsbaum (OF_ALLOW_DIRTY=1): Release ist nicht reproduzierbar"
fi
SHA=$(git rev-parse --short=10 HEAD)
ID="$(date -u +%Y%m%dT%H%M%SZ)-$SHA"
OUT="${OF_RELEASE_DIR:-$HOME/.cache/orderflow-binance}/releases/$ID"
mkdir -p "$OUT"

log "Web-Bundle"
npm run build -w @orderflow/web >&2
[ -f apps/web/dist/index.html ] || die "apps/web/dist/index.html fehlt"
cp -R apps/web/dist "$OUT/web"
# Keine Fixture-/Quelldateien im Bundle
if find "$OUT/web" -name '*.map' -o -name '*.ts' | grep -q .; then warn "Bundle enthält .map/.ts-Dateien"; fi

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
git=$(git rev-parse HEAD)
built_utc=$(date -u +%FT%TZ)
node=$(cat .nvmrc)
migrations=$(find packages/db/migrations -name '*.up.sql' | sed 's#.*/##' | sort | tail -1)
EOF
sha256_manifest "$OUT"
log "Release $ID: $(du -sh "$OUT" | cut -f1) unter $OUT"
echo "$ID"
