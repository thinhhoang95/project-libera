# Libera collab server image. Build from the repository root, because the
# server bundles the shared protocol from src/lib/collab/protocol:
#   docker build -f server/Dockerfile -t libera-collab .

FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY src/lib/collab/protocol src/lib/collab/protocol
COPY server server
RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4400
WORKDIR /app
RUN groupadd --system libera && useradd --system --gid libera --home /app libera \
    && mkdir -p /data/blobs && chown -R libera:libera /data
COPY --from=build --chown=libera:libera /repo/server/node_modules node_modules
COPY --from=build --chown=libera:libera /repo/server/dist dist
COPY --from=build --chown=libera:libera /repo/server/package.json package.json
USER libera
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migrations run at start (buildServer applies pending ones before listening).
CMD ["node", "--enable-source-maps", "dist/index.js"]
