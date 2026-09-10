#!/usr/bin/env bash
#
# One command from a fresh clone to a running Haro.
#
#   ./scripts/bootstrap.sh                  # Haro + qBittorrent, built-in player
#   ./scripts/bootstrap.sh --with-jellyfin  # also start Jellyfin and use it for playback
#   ./scripts/bootstrap.sh --no-start       # prepare everything, start nothing
#
# Installs Docker if it is missing, writes a working .env, seeds qBittorrent's
# config so there is no random first-run password, brings the dev stack up and
# generates sample episodes so there is something to press Play on.
#
# Idempotent: re-running reports what already exists rather than replacing it.
# For a real Raspberry Pi deployment use scripts/preflight.sh + docker-compose.yml.
#
set -uo pipefail

cd "$(dirname "$0")/.."

pass=0 warn=0 fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
note() { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }
say()  { printf '    %s\n' "$1"; }
die()  { bad "$1"; printf '\n\033[1mStopped.\033[0m %d passed, %d warnings, %d blocking\n' \
           "$pass" "$warn" "$fail"; exit 1; }

WITH_JELLYFIN=0
START=1
INSTALL_DOCKER=1
SEED=1

while [ $# -gt 0 ]; do
  case "$1" in
    --with-jellyfin)      WITH_JELLYFIN=1 ;;
    --no-start)           START=0 ;;
    --skip-docker-install) INSTALL_DOCKER=0 ;;
    --no-seed)            SEED=0 ;;
    -h|--help)            sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)                    echo "Unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

COMPOSE=(docker compose -f docker-compose.dev.yml)
[ "$WITH_JELLYFIN" -eq 1 ] && COMPOSE+=(--profile jellyfin)

HARO_PORT=7802
VITE_PORT=7803
QB_PORT=7808
JF_PORT=8096

# ---------------------------------------------------------------------------
head_ "Platform"

OS=$(uname -s)
ARCH=$(uname -m)
DISTRO=unknown
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  DISTRO=$(. /etc/os-release && echo "${ID:-unknown}")
  PRETTY=$(. /etc/os-release && echo "${PRETTY_NAME:-$DISTRO}")
else
  PRETTY="$OS"
fi

case "$ARCH" in
  x86_64|aarch64|arm64) ok "$PRETTY ($ARCH)" ;;
  armv7l|armv6l)        die "32-bit ARM ($ARCH). The node:26 image has no 32-bit build." ;;
  *)                    note "$PRETTY — unrecognised architecture $ARCH, continuing anyway" ;;
esac

if [ "$OS" != "Linux" ]; then
  note "Not Linux — Docker installation is manual on $OS"
  INSTALL_DOCKER=0
fi

# ---------------------------------------------------------------------------
head_ "Docker"

sudo_() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

install_docker() {
  say "Installing Docker Engine + the compose plugin. This needs sudo."
  case "$DISTRO" in
    fedora|rhel|centos|rocky|almalinux)
      sudo_ dnf -y install dnf-plugins-core || return 1
      sudo_ dnf -y config-manager addrepo --overwrite \
        --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo \
        || sudo_ dnf -y config-manager --add-repo \
             https://download.docker.com/linux/fedora/docker-ce.repo \
        || return 1
      sudo_ dnf -y install docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin || return 1
      ;;
    ubuntu|debian|linuxmint|pop|raspbian)
      sudo_ apt-get update || return 1
      sudo_ apt-get install -y ca-certificates curl || return 1
      sudo_ install -m 0755 -d /etc/apt/keyrings || return 1
      local base="https://download.docker.com/linux/${DISTRO}"
      case "$DISTRO" in linuxmint|pop) base="https://download.docker.com/linux/ubuntu" ;; esac
      sudo_ curl -fsSL "$base/gpg" -o /etc/apt/keyrings/docker.asc || return 1
      sudo_ chmod a+r /etc/apt/keyrings/docker.asc
      local codename
      codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] $base $codename stable" \
        | sudo_ tee /etc/apt/sources.list.d/docker.list >/dev/null
      sudo_ apt-get update || return 1
      sudo_ apt-get install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin || return 1
      ;;
    arch|manjaro|endeavouros)
      sudo_ pacman -Sy --noconfirm docker docker-compose docker-buildx || return 1
      ;;
    *)
      return 2
      ;;
  esac
  sudo_ systemctl enable --now docker || return 1
}

docker_ready() { docker info >/dev/null 2>&1; }

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/^Docker version //; s/,.*//'), compose $(docker compose version --short)"
elif [ "$INSTALL_DOCKER" -eq 0 ]; then
  bad "Docker is not installed and --skip-docker-install was given."
  case "$OS" in
    Darwin) say "Install Docker Desktop: brew install --cask docker" ;;
    *)      say "See https://docs.docker.com/engine/install/" ;;
  esac
  die "Cannot continue without Docker."
else
  note "Docker is not installed"
  if install_docker; then
    ok "Docker installed"
  else
    case $? in
      2) bad "No automated installer for '$DISTRO'."
         say "Install Docker Engine + the compose plugin, then re-run this script."
         say "https://docs.docker.com/engine/install/" ;;
      *) bad "Docker installation failed. See the output above." ;;
    esac
    die "Cannot continue without Docker."
  fi
fi

if ! docker_ready; then
  if ! getent group docker >/dev/null 2>&1; then
    sudo_ groupadd docker >/dev/null 2>&1
  fi
  if ! id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
    say "Adding $(id -un) to the 'docker' group…"
    sudo_ usermod -aG docker "$(id -un)"
    note "Group membership does not apply to this shell."
    printf '\n\033[1mAlmost there.\033[0m Start a new session, then re-run this script:\n\n'
    printf '    newgrp docker\n'
    printf '    ./scripts/bootstrap.sh%s\n\n' "$([ "$WITH_JELLYFIN" -eq 1 ] && echo ' --with-jellyfin')"
    printf 'Logging out and back in works too, and applies everywhere.\n'
    exit 0
  fi
  die "Cannot talk to the Docker daemon even though you are in the 'docker' group. Is it running? (systemctl status docker)"
fi
ok "Docker daemon reachable"

# ---------------------------------------------------------------------------
head_ "Ports"

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for entry in "$HARO_PORT:Haro API" "$VITE_PORT:Vite dev server" "$QB_PORT:qBittorrent WebUI"; do
  port=${entry%%:*}; label=${entry#*:}
  if port_busy "$port"; then
    # Our own stack holding the port is the normal re-run case.
    if [ -n "$("${COMPOSE[@]}" ps -q 2>/dev/null)" ]; then
      ok "$label :$port (held by this stack)"
    else
      bad "$label port $port is already in use by something else"
      say "Free it, or change the port in docker-compose.dev.yml and .env"
    fi
  else
    ok "$label :$port free"
  fi
done
if [ "$WITH_JELLYFIN" -eq 1 ] && port_busy "$JF_PORT" \
   && [ -z "$("${COMPOSE[@]}" ps -q jellyfin 2>/dev/null)" ]; then
  bad "Jellyfin port $JF_PORT is already in use"
fi
[ "$fail" -eq 0 ] || die "Free the ports above and re-run."

# ---------------------------------------------------------------------------
head_ "Configuration"

HARO_UID=$(id -u)
HARO_GID=$(id -g)

# qBittorrent's WebUI password is generated once and then lives in .env. It is
# deliberately not a constant in this script: it protects a WebUI that can add
# torrents and write to disk, and a password published in a repository is one
# port-mapping change away from being a real problem.
QB_PASSWORD=$(sed -n 's/^QBITTORRENT_PASSWORD=//p' .env 2>/dev/null | head -1)
case "$QB_PASSWORD" in
  ''|changeme) QB_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))') ;;
esac

# Every key bootstrap owns, and the value the dev stack needs.
dev_value() {
  case "$1" in
    PORT)                 echo "$HARO_PORT" ;;
    # One volume, two directories: a hardlink cannot cross a filesystem, and
    # two named volumes would be two filesystems. See docker-compose.dev.yml.
    DOWNLOAD_ROOT)        echo "/data/downloads" ;;
    LIBRARY_ROOT)         echo "/data/library" ;;
    QB_DOWNLOAD_ROOT)     echo "/data/downloads" ;;
    QBITTORRENT_URL)      echo "http://qbittorrent:$QB_PORT" ;;
    QBITTORRENT_USERNAME) echo "admin" ;;
    QBITTORRENT_PASSWORD) echo "$QB_PASSWORD" ;;
    JELLYFIN_URL)         echo "http://jellyfin:$JF_PORT" ;;
    PLAYER_MODE)          [ "$WITH_JELLYFIN" -eq 1 ] && echo "jellyfin" || echo "builtin" ;;
    HARO_UID)             echo "$HARO_UID" ;;
    HARO_GID)             echo "$HARO_GID" ;;
  esac
}
DEV_KEYS="PORT DOWNLOAD_ROOT LIBRARY_ROOT QB_DOWNLOAD_ROOT QBITTORRENT_URL QBITTORRENT_USERNAME QBITTORRENT_PASSWORD JELLYFIN_URL PLAYER_MODE HARO_UID HARO_GID"

set_key() { # set_key FILE KEY VALUE
  if grep -qE "^$2=" "$1"; then
    python3 - "$1" "$2" "$3" <<'PY'
import sys, re
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding='utf-8') as fh:
    lines = fh.readlines()
with open(path, 'w', encoding='utf-8') as fh:
    for line in lines:
        fh.write(f'{key}={value}\n' if re.match(rf'^{re.escape(key)}=', line) else line)
PY
  else
    printf '%s=%s\n' "$2" "$3" >> "$1"
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  for key in $DEV_KEYS; do set_key .env "$key" "$(dev_value "$key")"; done
  ok ".env created for the dev stack"
else
  ok ".env already exists — leaving it alone"
  drift=0
  for key in $DEV_KEYS; do
    want=$(dev_value "$key")
    have=$(sed -n "s/^$key=//p" .env | head -1)
    if [ "$have" != "$want" ]; then
      [ "$drift" -eq 0 ] && note "these differ from what the dev stack expects:"
      say "$key=${have:-<unset>}   (dev stack uses: $want)"
      drift=1
    fi
  done
  [ "$drift" -eq 0 ] && ok "dev keys match" || say "Edit .env yourself, or delete it and re-run."
fi

mkdir -p data/config data/qbittorrent/qBittorrent
[ "$WITH_JELLYFIN" -eq 1 ] && mkdir -p data/jellyfin/config data/jellyfin/cache
ok "data/ directories ready"

QB_CONF=data/qbittorrent/qBittorrent/qBittorrent.conf
if [ -f "$QB_CONF" ]; then
  ok "qBittorrent config already seeded"
else
  # PBKDF2-HMAC-SHA512, 100k iterations, 64-byte key, 16-byte salt — the format
  # qBittorrent stores and the only one it will accept.
  QB_HASH=$(python3 - "$QB_PASSWORD" <<'PYHASH'
import base64, hashlib, os, sys
salt = os.urandom(16)
key = hashlib.pbkdf2_hmac('sha512', sys.argv[1].encode(), salt, 100_000, 64)
print(f'@ByteArray({base64.b64encode(salt).decode()}:{base64.b64encode(key).decode()})')
PYHASH
  )
  # Recent qBittorrent generates a random admin password on first run and only
  # prints it to the container log. Seeding the config avoids that entirely.
  cat > "$QB_CONF" <<'QBCONF'
[Application]
FileLogger\Enabled=true

[BitTorrent]
Session\DefaultSavePath=/data/downloads
Session\TempPathEnabled=false

[Preferences]
Downloads\SavePath=/data/downloads
General\Locale=en
WebUI\Address=*
WebUI\Port=7808
WebUI\Username=admin
WebUI\LocalHostAuth=false
WebUI\CSRFProtection=false
WebUI\HostHeaderValidation=false
WebUI\Password_PBKDF2="__QB_HASH__"
QBCONF
  # The hash goes in afterwards: the heredoc above is quoted so that the
  # backslashes in qBittorrent's own key names survive verbatim.
  sed -i "s|__QB_HASH__|$QB_HASH|" "$QB_CONF"
  ok "qBittorrent seeded — admin / $QB_PASSWORD on :$QB_PORT"
fi

if [ "$START" -eq 0 ]; then
  printf '\n\033[1mPrepared.\033[0m %d passed, %d warnings\n' "$pass" "$warn"
  echo "Start it with: ${COMPOSE[*]} up -d"
  exit 0
fi

# ---------------------------------------------------------------------------
head_ "Starting"

say "Building the dev image (first run pulls Node 26 + ffmpeg — a few minutes)…"
"${COMPOSE[@]}" build haro-dev || die "Image build failed."
ok "image built"

say "Starting containers…"
"${COMPOSE[@]}" up -d || die "docker compose up failed."
ok "containers started"

say "Waiting for Haro to answer on :$HARO_PORT (first run installs the workspace)…"
ready=0
for _ in $(seq 1 120); do
  if curl -fsS --max-time 3 -o /dev/null "http://127.0.0.1:$HARO_PORT/api/health/live" 2>/dev/null; then
    ready=1; break
  fi
  sleep 5
done
if [ "$ready" -eq 1 ]; then
  ok "Haro is up"
else
  bad "Haro did not answer within 10 minutes."
  say "Check the log: ${COMPOSE[*]} logs -f haro-dev"
  die "Startup timed out."
fi

if [ "$SEED" -eq 1 ]; then
  say "Seeding sample episodes…"
  if "${COMPOSE[@]}" exec -T haro-dev \
       node --experimental-strip-types server/scripts/seed-dev.ts; then
    ok "sample media ready"
  else
    note "sample media could not be generated (the stack is still fine)"
  fi
fi

# ---------------------------------------------------------------------------
printf '\n\033[1mSummary:\033[0m %d passed, %d warnings, %d blocking\n' "$pass" "$warn" "$fail"
printf '\n\033[1mHaro is running.\033[0m\n\n'
printf '    UI (hot reload)   \033[32mhttp://localhost:%s\033[0m\n' "$VITE_PORT"
printf '    API               http://localhost:%s/api/health\n' "$HARO_PORT"
printf '    qBittorrent       http://localhost:%s   admin / %s\n' "$QB_PORT" "$QB_PASSWORD"
[ "$WITH_JELLYFIN" -eq 1 ] && \
printf '    Jellyfin          http://localhost:%s   (finish its setup wizard, then add an API key to .env)\n' "$JF_PORT"
printf '\n'
printf '    logs              %s logs -f haro-dev\n' "${COMPOSE[*]}"
printf '    tests             %s run --rm haro-dev pnpm test\n' "${COMPOSE[*]}"
printf '    stop              %s down\n' "${COMPOSE[*]}"
printf '\n'
