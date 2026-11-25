# syntax=docker/dockerfile:1
# Laufzeit-Image für die Node-Prozesse auf dem VPS: API (Standard-Kommando) sowie die
# Betriebswerkzeuge Migrationen (packages/db/src/cli.ts) und API-Rollenpasswort. Später kommen
# Importer und Recorder in dasselbe Image (eigene Compose-Dienste), ohne Umbau.
#
# Gebaut auf dem Mac für linux/amd64 (deploy/build-release.sh), per `docker save` übertragen;
# auf dem VPS wird nichts gebaut und nichts aus einer Registry gezogen außer diesem Basis-Image.
# Kontext = Repository-Wurzel; Ausschlüsse in deploy/api.Dockerfile.dockerignore (u. a. .env, data/).
#
# Node-Version = .nvmrc (24.22.3). Kein Build-Schritt: Node führt .ts per Type-Stripping aus.
ARG NODE_IMAGE=node:24.22.3-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NODE_ENV=production npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
# Nur Manifeste zuerst (Layer-Cache); npm ci braucht alle Workspace-Manifeste des Lockfiles.
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/importer/package.json apps/importer/
COPY apps/recorder/package.json apps/recorder/
COPY apps/web/package.json apps/web/
# Nur Produktionsabhängigkeiten der Node-Dienste (API; Importer/Recorder teilen dieselben Pakete).
RUN npm ci --omit=dev --ignore-scripts \
      --workspace=@orderflow/api --workspace=@orderflow/importer --workspace=@orderflow/recorder \
      --include-workspace-root=false \
 && npm cache clean --force

FROM ${NODE_IMAGE}
ARG OF_RELEASE=unknown
LABEL org.opencontainers.image.title="orderflow-binance" \
      org.opencontainers.image.version="${OF_RELEASE}"
ENV NODE_ENV=production OF_RELEASE=${OF_RELEASE} TZ=UTC
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/db/package.json packages/db/
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY apps/api/package.json apps/api/
COPY apps/api/src apps/api/src
COPY apps/importer/package.json apps/importer/
COPY apps/importer/src apps/importer/src
# Eigene, auf dem Host nicht vergebene UID (nicht 1000 = „ubuntu" auf dem VPS); Dateien gehören root
# und sind nur lesbar, der Container läuft zusätzlich mit read_only-Dateisystem (Compose).
USER 10001:10001
EXPOSE 8780
# API; Werkzeuge per `docker compose run --rm ops node packages/db/src/cli.ts status` usw.
CMD ["node", "apps/api/src/main.ts"]
