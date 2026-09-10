#!/usr/bin/env bash
#
# Run this ON THE PI before `docker compose up -d`.
# It checks the things that actually break Haro deployments, in the order they
# would bite you. Read-only: it changes nothing.
#
#   ./scripts/preflight.sh
#
# For a development machine use scripts/bootstrap.sh instead — the dev stack
# keeps downloads and the library in Docker-managed volumes, so none of the
# host-path checks below apply to it.
#
set -uo pipefail

pass=0 warn=0 fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Load .env so container-side paths are known.
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

CONTAINER_DOWNLOAD="${DOWNLOAD_ROOT:-/downloads/complete}"
CONTAINER_LIBRARY="${LIBRARY_ROOT:-/media/anime}"

# The paths that matter for hardlinks are the HOST sides of the volume
# mappings, so read them back out of docker-compose.yml rather than making
# you restate them somewhere.
host_path_for() {
  sed -n 's|^[[:space:]]*-[[:space:]]*\([^:#][^:]*\):'"$1"'[[:space:]]*$|\1|p' \
    docker-compose.yml 2>/dev/null | head -1
}

DOWNLOAD_HOST_PATH="${DOWNLOAD_HOST_PATH:-$(host_path_for "$CONTAINER_DOWNLOAD")}"
LIBRARY_HOST_PATH="${LIBRARY_HOST_PATH:-$(host_path_for "$CONTAINER_LIBRARY")}"

# Relative mounts (./data) resolve against the compose file's directory.
case "$DOWNLOAD_HOST_PATH" in ./*) DOWNLOAD_HOST_PATH="$PWD/${DOWNLOAD_HOST_PATH#./}" ;; esac
case "$LIBRARY_HOST_PATH" in ./*) LIBRARY_HOST_PATH="$PWD/${LIBRARY_HOST_PATH#./}" ;; esac

if [ -z "$DOWNLOAD_HOST_PATH" ] || [ -z "$LIBRARY_HOST_PATH" ]; then
  # The dev stack puts both roots in named volumes, so docker-compose.yml has
  # no host path to find and none of these checks would mean anything.
  if docker ps --filter 'name=haro-dev' --format '{{.Names}}' 2>/dev/null | grep -q .; then
    echo "The development stack is running (haro-dev)."
    echo "preflight.sh checks the production compose file; the dev stack keeps"
    echo "downloads and the library in Docker volumes, where hardlinks always work."
    echo "  ./scripts/bootstrap.sh          to (re)start it"
    exit 0
  fi
  echo "Could not read the volume mappings for $CONTAINER_DOWNLOAD and $CONTAINER_LIBRARY"
  echo "from docker-compose.yml. Pass them explicitly:"
  echo "  DOWNLOAD_HOST_PATH=/srv/downloads/complete LIBRARY_HOST_PATH=/srv/media/anime $0"
  exit 1
fi

head_ "Platform"

arch=$(uname -m)
case "$arch" in
  aarch64|arm64)
    ok "64-bit ARM ($arch)"
    ;;
  x86_64)
    ok "x86_64 — not a Pi, but supported"
    ;;
  armv7l|armv6l)
    bad "32-bit ARM ($arch). The node:26 image has no 32-bit build, so this will not run."
    echo "      Reinstall Raspberry Pi OS (64-bit) — a Pi 4B supports it. Verify with: uname -m → aarch64"
    ;;
  *)
    note "Unrecognized architecture: $arch"
    ;;
esac

if [ -f /proc/device-tree/model ]; then
  ok "Board: $(tr -d '\0' < /proc/device-tree/model)"
fi

total_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$total_mb" -ge 3500 ]; then
  ok "RAM: ${total_mb}MB total, ${avail_mb}MB available"
elif [ "$total_mb" -ge 1800 ]; then
  note "RAM: ${total_mb}MB. Enough to run Haro, but a local image build may be tight."
  echo "      Prefer the prebuilt image (docker compose pull) over building on the Pi."
else
  bad "RAM: ${total_mb}MB. Building on-device will fail; use the prebuilt image."
fi

swap_mb=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$swap_mb" -lt 512 ] && [ "$total_mb" -lt 3500 ]; then
  note "Swap: ${swap_mb}MB. Consider raising CONF_SWAPSIZE in /etc/dphys-swapfile if a build OOMs."
fi

head_ "Docker"

if command -v docker >/dev/null 2>&1; then
  ok "docker: $(docker --version | cut -d, -f1)"
  if docker compose version >/dev/null 2>&1; then
    ok "compose: $(docker compose version --short 2>/dev/null)"
  else
    bad "'docker compose' not available. Install the compose plugin."
  fi
  if ! docker info >/dev/null 2>&1; then
    bad "Cannot talk to the Docker daemon. Is it running, and is your user in the 'docker' group?"
  fi
else
  bad "docker is not installed."
fi

head_ "Storage — hardlinks require one filesystem"

if [ -d "$DOWNLOAD_HOST_PATH" ]; then
  ok "downloads: $DOWNLOAD_HOST_PATH"
else
  bad "downloads path does not exist: $DOWNLOAD_HOST_PATH"
fi

if [ -d "$LIBRARY_HOST_PATH" ]; then
  ok "library:   $LIBRARY_HOST_PATH"
else
  note "library path does not exist yet: $LIBRARY_HOST_PATH (Haro will create it)"
fi

if [ -d "$DOWNLOAD_HOST_PATH" ] && [ -d "$LIBRARY_HOST_PATH" ]; then
  dev_dl=$(stat -c %d "$DOWNLOAD_HOST_PATH")
  dev_lib=$(stat -c %d "$LIBRARY_HOST_PATH")
  if [ "$dev_dl" = "$dev_lib" ]; then
    ok "both on the same filesystem (device $dev_dl) — hardlinks will work"
  else
    bad "different filesystems (device $dev_dl vs $dev_lib). Hardlinks cannot cross devices."
    echo "      Move them under one mount, or imports will fail with EXDEV."
  fi

  probe="$DOWNLOAD_HOST_PATH/.haro-preflight"
  target="$LIBRARY_HOST_PATH/.haro-preflight"
  if touch "$probe" 2>/dev/null; then
    rm -f "$target" 2>/dev/null
    if ln "$probe" "$target" 2>/dev/null; then
      ok "hardlink test succeeded"
    else
      bad "hardlink test failed — check filesystem type and permissions"
    fi
    rm -f "$probe" "$target" 2>/dev/null
  else
    note "cannot write to $DOWNLOAD_HOST_PATH as $(id -un); Haro runs as the UID in docker-compose.yml"
  fi

  fstype=$(stat -f -c %T "$DOWNLOAD_HOST_PATH" 2>/dev/null || echo unknown)
  case "$fstype" in
    ext2/ext3|ext4|btrfs|xfs|zfs) ok "filesystem: $fstype (supports hardlinks)" ;;
    msdos|vfat|exfat)             bad "filesystem: $fstype — no hardlink support. Reformat to ext4." ;;
    *)                            note "filesystem: $fstype — verify it supports hardlinks" ;;
  esac
fi

head_ "Ownership"

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  qb=$(docker ps --filter "name=qbittorrent" --format '{{.Names}}' 2>/dev/null | head -1)
  if [ -n "$qb" ]; then
    ids=$(docker exec "$qb" id 2>/dev/null || true)
    if [ -n "$ids" ]; then
      uid=$(echo "$ids" | sed -n 's/.*uid=\([0-9]*\).*/\1/p')
      gid=$(echo "$ids" | sed -n 's/.*gid=\([0-9]*\).*/\1/p')
      ok "qBittorrent runs as ${uid}:${gid}"
      current=$(grep -E "^\s*user:" docker-compose.yml 2>/dev/null | tr -d " '\"" | cut -d: -f2-)
      if [ "$current" = "${uid}:${gid}" ]; then
        ok "docker-compose.yml user: matches"
      else
        bad "docker-compose.yml has user: '${current:-unset}' — set it to '${uid}:${gid}'"
      fi
    fi
  else
    note "no running container named *qbittorrent*; set user: in docker-compose.yml to its PUID:PGID"
  fi
fi

head_ "Services"

check_http() {
  local name=$1 url=$2
  if curl -fsS --max-time 5 -o /dev/null "$url" 2>/dev/null; then
    ok "$name reachable at $url"
  else
    note "$name did not answer at $url (fine if it only listens inside Docker)"
  fi
}
# Probe on the loopback port these services are configured on rather than a
# fixed 8080/8096 — the hostname in .env is container-side and resolves nowhere
# out here, but the port is the one that got published.
local_url() { # local_url <configured-url> <default-port> <path>
  local port
  port=$(printf '%s' "$1" | sed -n 's|^https\?://[^/:]*:\([0-9]\+\).*|\1|p')
  printf 'http://127.0.0.1:%s%s' "${port:-$2}" "$3"
}
check_http "qBittorrent" "$(local_url "${QBITTORRENT_URL:-}" 8080 /api/v2/app/version)"
if [ "${PLAYER_MODE:-auto}" = "builtin" ] || [ -z "${JELLYFIN_API_KEY:-}" ]; then
  ok "Jellyfin not in use (PLAYER_MODE=${PLAYER_MODE:-auto}, no API key) — built-in player"
else
  check_http "Jellyfin" "$(local_url "${JELLYFIN_URL:-}" 8096 /System/Info/Public)"
fi
check_http "AnimeGarden" "https://api.animes.garden/resources?pageSize=1"
check_http "Bangumi"     "https://api.bgm.tv/calendar"

if grep -q "host.docker.internal:host-gateway" docker-compose.yml 2>/dev/null; then
  ok "docker-compose.yml maps host.docker.internal (required on Linux)"
else
  bad "docker-compose.yml is missing extra_hosts: host.docker.internal:host-gateway"
fi

printf '\n\033[1mSummary:\033[0m %d passed, %d warnings, %d blocking\n' "$pass" "$warn" "$fail"
[ "$fail" -eq 0 ] || { echo "Fix the blocking items before starting Haro."; exit 1; }
echo "Ready. Start with: docker compose up -d"
