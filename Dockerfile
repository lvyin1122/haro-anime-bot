# syntax=docker/dockerfile:1
#
# Multi-stage build. node:26-alpine publishes linux/arm64, so this builds
# natively on a Raspberry Pi. Node 26 is required: `anipar` uses duplicate
# named capture groups and throws a SyntaxError at import time on Node < 24.
#
# The server is bundled by esbuild into a single dist/index.js with all
# dependencies inlined, so the runtime stage carries no node_modules at all
# and there is no native module / node-gyp step anywhere in the build.
#
# Stages: `dev` (docker-compose.dev.yml), `build` → `runtime` (production).

# --- dev -------------------------------------------------------------------
# Used only by docker-compose.dev.yml, which bind-mounts the source over /app.
# It exists so ffmpeg and pnpm are baked into the image instead of being
# installed on every `up`.
FROM node:26-alpine AS dev
WORKDIR /app

RUN apk add --no-cache tzdata ffmpeg

# The container runs as the developer's own uid (see docker-compose.dev.yml) so
# that files it writes into the bind-mounted source tree are not root-owned.
# That uid has no passwd entry, so HOME must point somewhere world-writable and
# the pnpm store must be reachable without one.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    HOME=/tmp \
    npm_config_store_dir=/pnpm/store \
    # pnpm prompts before replacing a node_modules it considers stale, and
    # refuses outright when there is no TTY to prompt on — which is every
    # container start. One interrupted install is enough to trigger it, and the
    # service then never starts again. CI=true is what actually suppresses it;
    # the npm_config_confirm_modules_purge setting is ignored from the
    # environment. The install below opts back out of the frozen lockfile CI
    # would otherwise imply, so editing a package.json here still works.
    CI=true \
    NODE_ENV=development
RUN npm install -g pnpm@11.10.0

# Warm the pnpm store at image-build time so the first `up` resolves from disk
# rather than the network. node_modules themselves live in named volumes that
# start empty, so the install still has to run — it is just fast.
# Non-fatal: a cold store only makes that first install slower.
COPY pnpm-lock.yaml ./
RUN pnpm fetch || true
RUN chmod -R 0777 /pnpm

CMD ["sh", "-c", "pnpm install --prefer-offline --no-frozen-lockfile && pnpm dev"]

# --- build -----------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app

# Rollup's bundling pass is the memory peak of this build. Capping the heap
# makes V8 collect rather than balloon, which is what keeps an on-device build
# alive on a 2GB Raspberry Pi.
ENV NODE_OPTIONS=--max-old-space-size=1536

RUN npm install -g pnpm@11.10.0

# Copy manifests and the lockfile first so dependency install is cached
# independently of source — and so --frozen-lockfile can actually succeed.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile

COPY . .

# web → web/dist (static assets), server → server/dist/index.js (bundle)
RUN pnpm --filter @haro/web build && pnpm --filter @haro/server build

# --- runtime ---------------------------------------------------------------
FROM node:26-alpine AS runtime
WORKDIR /app

# ffmpeg/ffprobe back the built-in player: ffprobe decides direct-play vs
# remux vs transcode, ffmpeg produces the HLS segments.
RUN apk add --no-cache tzdata wget ffmpeg

ENV NODE_ENV=production \
    PORT=7802 \
    WEB_ROOT=/app/web \
    # Bounded heap so Haro cannot crowd out Jellyfin transcoding on a shared
    # Pi. Far more than this workload needs — the largest allocation is a
    # single page of AnimeGarden results.
    NODE_OPTIONS=--max-old-space-size=512

COPY --from=build /app/server/dist ./
COPY --from=build /app/web/dist ./web

EXPOSE 7802

# /api/health/live is dependency-free — it answers even when qBittorrent or
# Jellyfin are down, so an unhealthy container means the app itself is broken.
# The start period is generous because a cold Pi 4B on an SD card takes its
# time getting Node up.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7802/api/health/live || exit 1

CMD ["node", "index.js"]
