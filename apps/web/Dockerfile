# Web AMC — Next.js standalone (build depuis la racine du monorepo)
#   docker build -f apps/web/Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t amc-web .
FROM node:20-bookworm-slim AS build
WORKDIR /repo
ARG API_INTERNAL_URL=http://api:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
COPY package.json package-lock.json ./
COPY packages/types/package.json packages/types/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/types packages/types
COPY apps/web apps/web
RUN npm run build -w @amc/types && npm run build -w @amc/web

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3100 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd -r amc && useradd -r -g amc amc
COPY --from=build --chown=amc:amc /repo/apps/web/.next/standalone ./
COPY --from=build --chown=amc:amc /repo/apps/web/.next/static ./apps/web/.next/static
USER amc
EXPOSE 3100
CMD ["node", "apps/web/server.js"]
