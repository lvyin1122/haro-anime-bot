# Haro

Self-hosted anime subscription manager for a Raspberry Pi. Browse and search anime, read the
details from Bangumi, subscribe to a series, and have new episodes downloaded through qBittorrent
and filed into Jellyfin with correct metadata — without touching a magnet link by hand.

Runs as a single Docker container alongside your existing qBittorrent and Jellyfin.

## What it does

- **Browse & search** — Bangumi's weekly airing calendar, Bangumi anime search, and full-text
  search over [AnimeGarden](https://animes.garden) releases.
- **Anime detail** — poster, synopsis, score, tags and the full episode list from Bangumi, next to
  every available release grouped by fansub group.
- **Subscribe** — pick a fansub and keyword filters, with a live preview showing exactly which
  releases match and what episode numbers they parse to before you commit.
- **Track & download** — polls for new episodes, hands magnets to qBittorrent under its own
  category and per-subscription tag, and follows them to completion.
- **File into Jellyfin** — hardlinks the finished video into
  `Series (Year)/Season 01/Series S01E27.mkv`, writes Kodi-format NFO metadata and cover art from
  Bangumi, and triggers a library scan. qBittorrent keeps seeding the original file; the hardlink
  costs no extra disk.
- **Watch** — the **Library** tab lists everything that has landed, badged with an unwatched count,
  and each episode links straight into the Jellyfin web player. Watched state and resume position
  come from Jellyfin, so finished episodes drop out of the "new" list on their own. Imported cells
  in the episode grid are play links too.

Nothing is ever deleted automatically.

## Requirements

- A Raspberry Pi 4B (or any arm64/amd64 host) running a **64-bit OS** with Docker and Docker Compose
- qBittorrent with its Web UI enabled
- Jellyfin with a **Shows** library pointed at your anime folder, and **NFO** enabled as a metadata
  reader for it
- Downloads and the Jellyfin library on the **same filesystem** — hardlinks cannot cross devices

> **64-bit is not optional.** `uname -m` must print `aarch64`. The Node 26 base image publishes no
> 32-bit ARM build, so Haro cannot run on 32-bit Raspberry Pi OS. A Pi 4B supports 64-bit; older
> installs often still run the 32-bit image.

## Setup

```bash
cp .env.example .env
$EDITOR .env                     # qBittorrent + Jellyfin credentials
$EDITOR docker-compose.yml       # host paths and user: PUID:PGID

./scripts/preflight.sh           # checks arch, RAM, hardlinks, ownership, services
docker compose up -d --build
```

`preflight.sh` is read-only and checks, in the order they would bite you: 64-bit arch, available
RAM, Docker, that both media paths are on one filesystem (with a real hardlink test), whether
`user:` matches qBittorrent's PUID/PGID, and service reachability. Fix anything it marks ✗ first.

Then open `http://<pi>:3000` and check **Settings** — every service should be green and the
hardlink probe should pass before you subscribe to anything.

### Running on a Pi 4B

Building the web bundle on-device takes roughly 4 minutes on a 4GB Pi 4B and needs about 1.5GB
free. That is fine on 4GB and 8GB boards. On a 1GB or 2GB Pi, skip the build entirely and pull the
prebuilt `linux/arm64` image instead — comment out `build:` in `docker-compose.yml`, uncomment the
`image: ghcr.io/...` line, then:

```bash
# The package inherits the repo's private visibility, so authenticate first.
# Create a token at github.com/settings/tokens with the read:packages scope.
echo "$GHCR_TOKEN" | docker login ghcr.io -u heyuwang1999 --password-stdin

docker compose pull && docker compose up -d
```

The image is published for `linux/amd64` and `linux/arm64` by `.github/workflows/docker.yml` on
every push to `main`. Make the package public in its GitHub settings if you would rather skip the
`docker login` step.

At runtime Haro is light — the container is capped at 768MB with a 512MB Node heap, well above what
it uses. A few other things are tuned for SD cards specifically: SQLite runs in WAL mode with
`synchronous=NORMAL`, the activity log self-trims, and Docker logs rotate at 10MB × 3.

### The four things that break first-run setups

1. **`extra_hosts: host.docker.internal:host-gateway`** — already in `docker-compose.yml`. On Linux
   that hostname does not resolve without it, and every qBittorrent/Jellyfin call fails.
2. **Same filesystem.** Verify with `stat -c %d /srv/downloads/complete /srv/media/anime` — the two
   numbers must match, or imports fail with `EXDEV`.
3. **Matching ownership.** Set `user:` in `docker-compose.yml` to qBittorrent's `PUID:PGID`
   (`docker exec qbittorrent id`), or hardlink creation fails with `EACCES`.
4. **NFO enabled in Jellyfin.** If the local NFO reader is off, Jellyfin ignores the metadata we
   write and falls back to TMDB, which matches Chinese anime titles poorly. The Settings page
   checks this and tells you.

## Configuration

All configuration is environment variables — see [`.env.example`](.env.example). The two worth
explaining:

| Variable | Meaning |
| --- | --- |
| `DOWNLOAD_ROOT` | Completed downloads **as this container sees them** |
| `QB_DOWNLOAD_ROOT` | The same directory **as qBittorrent sees it** |
| `JELLYFIN_URL` | How **this container** reaches Jellyfin |
| `JELLYFIN_PUBLIC_URL` | How **a browser** reaches Jellyfin, for Play links |

qBittorrent reports paths in its own container's namespace. Keeping `DOWNLOAD_ROOT` and
`QB_DOWNLOAD_ROOT` identical makes the mapping a no-op, which is the arrangement to aim for; they
exist separately for setups where the two containers mount the same directory at different paths.

The Jellyfin pair splits for the same reason: `host.docker.internal:8096` is meaningful inside the
container but resolves nowhere in a browser, so it cannot appear in a link. Leave
`JELLYFIN_PUBLIC_URL` empty and the UI assumes Jellyfin is on the host you opened Haro from at port
8096 — correct for a single Pi. Set it when Jellyfin lives elsewhere or behind a domain.

## Development

```bash
docker compose -f docker-compose.dev.yml up      # API :3000, UI with HMR :5173
docker compose -f docker-compose.dev.yml run --rm haro-dev pnpm test
```

Developing in the container is the supported path because **Node ≥ 24 is required** — `anipar`
throws a `SyntaxError` at import time on Node 22. On the host you would need `nvm install 26` first.

```
server/   Hono API, SQLite via built-in node:sqlite, background poller and importer
web/      Vite + React 19 + TanStack Router/Query + Tailwind
AnimeGarden/  read-only upstream reference checkout — not part of the build
```

`pnpm test` covers the parts that fail silently in production: infohash normalization, release-title
parsing against real fansub titles, NFO generation and escaping, and path mapping plus hardlinking.

## How it works

```
Bangumi ──metadata──┐
                    ├─→ subscription ──poll──→ AnimeGarden /resources?subject=&after=
qBittorrent ←magnet─┘                                    │
      │                                            anipar parses S/E
      └─ downloads to DOWNLOAD_ROOT                       │
                    └──hardlink + NFO + poster──→ LIBRARY_ROOT ──scan──→ Jellyfin
```

Subscriptions poll `GET /resources?subject=<bangumiId>&after=<cursor>` — the same data
AnimeGarden's `feed.xml` is generated from, but structured, so the cursor returns exactly what is
new rather than a fixed feed window.

Two details that are easy to get wrong and are handled here:

- **Infohash encoding.** `torrents/add` returns no hash, so it has to be derived from the magnet —
  but roughly two thirds of AnimeGarden magnets use base32 infohashes while qBittorrent only reports
  hex. Everything is normalized to lowercase hex before storage or lookup.
- **Completion detection.** qBittorrent 4.x reports a finished torrent as `pausedUP` and 5.x as
  `stoppedUP`, among others. Completion is judged on `progress` and `completion_on` instead of
  state strings.

## License and credits

**AGPL-3.0** — see [LICENSE](./LICENSE). The server bundles
[`@animegarden/client`](https://www.npmjs.com/package/@animegarden/client), which is AGPL-3.0, so
the combined work inherits it. [NOTICE.md](./NOTICE.md) has the full dependency breakdown.

Release data from [Anime Garden](https://animes.garden), title parsing by
[anipar](https://www.npmjs.com/package/anipar), metadata and cover art from
[Bangumi 番组计划](https://bgm.tv). Haro is a client for these services and does not operate them.
