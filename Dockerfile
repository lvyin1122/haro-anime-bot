# syntax=docker/dockerfile:1
#
# Multi-stage build. node:26-alpine publishes linux/arm64, so this builds
# natively on a Raspberry Pi. Node 26 is required: `anipar` uses duplicate
# named capture groups and throws a SyntaxError at import time on Node < 24.
#
# The server is bundled by esbuild into a single dist/index.js with all
# dependencies inlined, so the runtime stage carries no node_modules at all
# and there is no native module / node-gyp step anywhere in the build.

# ---------------------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app

# Rollup's bundling pass is the memory peak of this build. Capping the heap
# makes V8 collect rather than balloon, which is what keeps an on-device build
# alive on a 2GB Raspberry Pi.
ENV NODE_OPTIONS=--max-old-space-size=1536

RUN npm install -g pnpm@11.10.0

# Copy manifests first so dependency install is cached independently of source.
COPY package.json pnpm-workspace.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .

# web → web/dist (static assets), server → server/dist/index.js (bundle)
RUN pnpm --filter @haro/web build && pnpm --filter @haro/server build

# ---------------------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache tzdata wget

ENV NODE_ENV=production \
    PORT=3000 \
    WEB_ROOT=/app/web \
    # Bounded heap so Haro cannot crowd out Jellyfin transcoding on a shared
    # Pi. Far more than this workload needs — the largest allocation is a
    # single page of AnimeGarden results.
    NODE_OPTIONS=--max-old-space-size=512

COPY --from=build /app/server/dist ./
COPY --from=build /app/web/dist ./web

EXPOSE 3000

# /api/health/live is dependency-free — it answers even when qBittorrent or
# Jellyfin are down, so an unhealthy container means the app itself is broken.
# The start period is generous because a cold Pi 4B on an SD card takes its
# time getting Node up.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health/live || exit 1

CMD ["node", "index.js"]
