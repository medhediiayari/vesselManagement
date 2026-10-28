# API AMC — image de production (build depuis la racine du monorepo)
#   docker build -f apps/api/Dockerfile -t amc-api .
FROM node:20-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/types packages/types
COPY apps/api apps/api
RUN npm run build -w @amc/types \
 && npx prisma generate --schema apps/api/prisma/schema.prisma \
 && npm run build -w @amc/api \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/* \
 && groupadd -r amc && useradd -r -g amc amc
COPY --from=build --chown=amc:amc /repo/node_modules node_modules
COPY --from=build --chown=amc:amc /repo/packages/types packages/types
COPY --from=build --chown=amc:amc /repo/apps/api/package.json apps/api/package.json
COPY --from=build --chown=amc:amc /repo/apps/api/dist apps/api/dist
COPY --from=build --chown=amc:amc /repo/apps/api/prisma apps/api/prisma
USER amc
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Les migrations sont appliquées par le service « migrate » (prisma migrate deploy) avant le démarrage
CMD ["node", "dist/main.js"]
