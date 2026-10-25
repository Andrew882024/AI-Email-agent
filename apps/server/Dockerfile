# Production image: the API server, also serving the built web app.
# Build from the repository root: docker build -f apps/server/Dockerfile .
FROM node:24-slim AS base
RUN npm install -g pnpm@11.5.0
ENV CI=true

FROM base AS web
WORKDIR /build/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web/ ./
RUN pnpm run build

FROM base AS server
WORKDIR /build/server
COPY apps/server/package.json apps/server/pnpm-lock.yaml apps/server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/server/ ./
RUN pnpm run build

FROM base AS prod-deps
WORKDIR /build/server
COPY apps/server/package.json apps/server/pnpm-lock.yaml apps/server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim
ENV NODE_ENV=production SERVER_HOST=0.0.0.0 WEB_ROOT=/app/web APP_DATA_DIR=/data
WORKDIR /app
COPY --from=prod-deps /build/server/node_modules ./node_modules
COPY --from=server /build/server/package.json ./
COPY --from=server /build/server/dist ./dist
COPY --from=web /build/web/dist ./web
# Chat uploads and logs; mounted from the host so they survive new versions.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
CMD ["node", "dist/main.js"]
