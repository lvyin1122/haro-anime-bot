# Haro

Self-hosted anime subscription manager. Browse and search anime, read the details from Bangumi,
subscribe to a series, and have new episodes downloaded through qBittorrent and filed away with
correct metadata — without touching a magnet link by hand. Then watch them, either in Haro's own
player or in Jellyfin.

Runs as a single Docker container.

## Quick start

```bash
git clone <this repo> && cd haro-anime-bot
./scripts/bootstrap.sh
```

That is the whole thing. The script installs Docker if it is missing, writes a working `.env`,
starts Haro alongside its own qBittorrent, and generates a few sample episodes so there is
something to press Play on. Then open **<http://localhost:7803>**.

| | |
| --- | --- |
| `./scripts/bootstrap.sh` | Haro + qBittorrent, watching in the built-in player |
| `./scripts/bootstrap.sh --with-jellyfin` | also start Jellyfin, and use it for playback |
| `./scripts/bootstrap.sh --no-start` | set everything up, start nothing |

Re-running is safe: it reports what already exists rather than replacing it. It never overwrites an
`.env` you have edited — it tells you which keys differ and leaves the file alone.

Deploying to a Raspberry Pi is a different path; see [Deploying to a Pi](#deploying-to-a-pi).

## What it does

- **Browse & search** — Bangumi's weekly airing calendar, Bangumi anime search, and full-text
  search over [AnimeGarden](https://animes.garden) releases.
- **Anime detail** — poster, synopsis, score, tags and the full episode list from Bangumi, next to
  every available release grouped by fansub group.
- **Subscribe** — pick a fansub and keyword filters, with a live preview showing exactly which
  releases match and what episode numbers they parse to before you commit.
- **Track & download** — polls for new episodes, hands magnets to qBittorrent under its own
  category and per-subscription tag, and follows them to completion.
- **File into a library** — hardlinks the finished video into
  `Series (Year)/Season 01/Series S01E27.mkv`, and writes Kodi-format NFO metadata and cover art
  from Bangumi so Jellyfin, Kodi or Plex can read it. qBittorrent keeps seeding the original file;
  the hardlink costs no extra disk.
- **Watch** — the **Library** tab lists everything that has landed, badged with an unwatched count.
  Play opens the episode in Haro's own player, or deep-links into Jellyfin if you would rather use
  that. Either way, finished episodes drop out of the "new" list on their own.

Nothing is ever deleted automatically.

## Watching

Haro can play episodes itself, or hand them to Jellyfin. `PLAYER_MODE` decides, and defaults to
`auto` — Jellyfin when its credentials are set, the built-in player otherwise.

### The built-in player

Needs nothing installed beyond Haro itself. It supports subtitle and audio track selection,
playback speed from 0.5× to 3×, resume, picture-in-picture and the usual keyboard shortcuts.

The interesting part is getting a fansub release into a browser at all. Almost all of them are
Matroska, which no browser opens, and many are 10-bit HEVC, which no browser decodes. So ffmpeg
takes one of three routes, and the player tells you which:

| | |
| --- | --- |
| **Direct play** | Already an MP4 of streams your browser handles. Served as-is; ffmpeg never runs. |
| **Repackaging** | Streams are fine, the container is not. `-c copy` into fMP4 — essentially free. |
| **Transcoding** | Something has to be re-encoded. Expensive, and slow on a Pi. |

Which route a file takes depends on your browser as much as the file: your browser is asked what it
can decode (`MediaSource.isTypeSupported`) and the answer is sent with the request, so Safari on a
Mac may direct-play an HEVC release that Firefox on Linux has to transcode.

Subtitles are rendered by [libass](https://github.com/libass/libass) compiled to WebAssembly, using
the fonts attached to the Matroska file. That matters for anime specifically: ASS subtitles carry
positioning, fades and typeset signs that `<track>` and WebVTT throw away.

Watched state and resume positions are stored locally, in Haro's own database.

### Jellyfin

Set `PLAYER_MODE=jellyfin` (or just fill in the credentials and leave it on `auto`). Play buttons
become deep links into the Jellyfin web client, watched state is read back from Jellyfin, and Haro
triggers a library scan after each import.

Jellyfin needs a **Shows** library pointed at your anime folder, with **NFO** enabled as a metadata
reader for it. If the local NFO reader is off, Jellyfin ignores the metadata Haro writes and falls
back to TMDB, which matches Chinese anime titles poorly. The Settings page checks this and tells
you.

Haro writes NFO metadata and cover art whether or not `PLAYER_MODE` is `jellyfin`, so pointing a
Jellyfin, Kodi or Plex at `LIBRARY_ROOT` works regardless.

## Ports

Everything is on 78xx, deliberately clear of the 3000s.

| Port | |
| --- | --- |
| **7803** | The UI in development (Vite, hot reload) — **open this one** |
| **7802** | The API, and the whole app in production |
| **7808** | qBittorrent's Web UI (dev stack; `admin` / `haro-dev`) |
| 8096 | Jellyfin, if you started it |

All configurable: `PORT` in `.env` for Haro, and the port mappings in the compose file for the rest.

## Deploying to a Pi

`bootstrap.sh` sets up a development machine. A real deployment uses `docker-compose.yml`, which
expects qBittorrent and Jellyfin to already exist on the host and mounts real host directories:

```bash
cp .env.example .env
$EDITOR .env                     # qBittorrent credentials, and Jellyfin's if you use it
$EDITOR docker-compose.yml       # host paths and user: PUID:PGID

./scripts/preflight.sh           # checks arch, RAM, hardlinks, ownership, services
docker compose up -d --build
```

`preflight.sh` is read-only and checks, in the order they would bite you: 64-bit arch, available
RAM, Docker, that both media paths are on one filesystem (with a real hardlink test), whether
`user:` matches qBittorrent's PUID/PGID, and service reachability. Fix anything it marks ✗ first.

Then open `http://<pi>:7802` and check **Settings** — every service should be green and the
hardlink probe should pass before you subscribe to anything.

### Requirements

- A Raspberry Pi 4B (or any arm64/amd64 host) running a **64-bit OS** with Docker and Docker Compose
- qBittorrent with its Web UI enabled
- Downloads and the library on the **same filesystem** — hardlinks cannot cross devices

> **64-bit is not optional.** `uname -m` must print `aarch64`. The Node 26 base image publishes no
> 32-bit ARM build, so Haro cannot run on 32-bit Raspberry Pi OS. A Pi 4B supports 64-bit; older
> installs often still run the 32-bit image.

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

**Transcoding is the exception.** Re-encoding 1080p in software is beyond a Pi 4B in real time. If
you watch on a Pi-hosted instance, prefer releases your browser can decode — or use Jellyfin, which
can reach the Pi's hardware decoder in ways a container-internal ffmpeg cannot.

### The four things that break first-run setups

1. **`extra_hosts: host.docker.internal:host-gateway`** — already in `docker-compose.yml`. On Linux
   that hostname does not resolve without it, and every qBittorrent/Jellyfin call fails.
   (The dev stack does not need it: services find each other by name on a compose network.)
2. **Same filesystem.** Verify with `stat -c %d /srv/downloads/complete /srv/media/anime` — the two
   numbers must match, or imports fail with `EXDEV`.
3. **Matching ownership.** Set `user:` in `docker-compose.yml` to qBittorrent's `PUID:PGID`
   (`docker exec qbittorrent id`), or hardlink creation fails with `EACCES`.
4. **NFO enabled in Jellyfin**, if you use Jellyfin. See [Jellyfin](#jellyfin) above.

## Configuration

All configuration is environment variables — see [`.env.example`](.env.example). The ones worth
explaining:

| Variable | Meaning |
| --- | --- |
| `PLAYER_MODE` | `builtin`, `jellyfin`, or `auto` (default) |
| `DOWNLOAD_ROOT` | Completed downloads **as this container sees them** |
| `QB_DOWNLOAD_ROOT` | The same directory **as qBittorrent sees it** |
| `LIBRARY_ROOT` | Where imported episodes are filed. Must share a filesystem with `DOWNLOAD_ROOT` |
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
./scripts/bootstrap.sh                                             # start everything
docker compose -f docker-compose.dev.yml logs -f haro-dev          # watch it
docker compose -f docker-compose.dev.yml run --rm haro-dev pnpm test
docker compose -f docker-compose.dev.yml run --rm haro-dev pnpm -r typecheck
docker compose -f docker-compose.dev.yml down                      # stop
```

Developing in the container is the supported path because **Node ≥ 26 is required** — `anipar`
throws a `SyntaxError` at import time on Node 22. On the host you would need `nvm install 26` first.

```
server/   Hono API, SQLite via built-in node:sqlite, background poller, importer, ffmpeg player
web/      Vite + React 19 + TanStack Router/Query + Tailwind
AnimeGarden/  read-only upstream reference checkout — not part of the build
```

`pnpm test` covers the parts that fail silently in production: infohash normalization,
release-title parsing against real fansub titles, NFO generation and escaping, path mapping and
hardlinking, and the player's format decisions and MP4 segment surgery.

The sample episodes `bootstrap.sh` generates are deliberately one per playback route — an H.264
MKV that gets repackaged, a 10-bit MKV with two audio tracks and embedded ASS that gets transcoded,
and an MP4 that direct-plays. Regenerate them any time:

```bash
docker compose -f docker-compose.dev.yml exec haro-dev \
  node --experimental-strip-types server/scripts/seed-dev.ts
```

## How it works

```
Bangumi ──metadata──┐
                    ├─→ subscription ──poll──→ AnimeGarden /resources?subject=&after=
qBittorrent ←magnet─┘                                    │
      │                                            anipar parses S/E
      └─ downloads to DOWNLOAD_ROOT                       │
                    └──hardlink + NFO + poster──→ LIBRARY_ROOT ──→ built-in player
                                                              └──→ Jellyfin scan
```

Subscriptions poll `GET /resources?subject=<bangumiId>&after=<cursor>` — the same data
AnimeGarden's `feed.xml` is generated from, but structured, so the cursor returns exactly what is
new rather than a fixed feed window.

Four details that are easy to get wrong and are handled here:

- **Infohash encoding.** `torrents/add` returns no hash, so it has to be derived from the magnet —
  but roughly two thirds of AnimeGarden magnets use base32 infohashes while qBittorrent only reports
  hex. Everything is normalized to lowercase hex before storage or lookup.
- **Completion detection.** qBittorrent 4.x reports a finished torrent as `pausedUP` and 5.x as
  `stoppedUP`, among others. Completion is judged on `progress` and `completion_on` instead of
  state strings.
- **Segment boundaries.** A repackaged stream can only be cut at a keyframe, so the segment plan is
  built from a cached keyframe scan of the source rather than a fixed interval. A re-encoded one
  makes its own keyframes, so it uses uniform segments and skips the scan.
- **Segment timestamps.** ffmpeg numbers every output it produces from zero, and no combination of
  `-copyts`, `-output_ts_offset` or `-avoid_negative_ts` changes what the MP4 muxer writes — so a
  segment cut from ten minutes in still claims to start at zero, and a player would stack every
  segment on top of the first. Haro rewrites `tfdt` in each fragment instead. The values within one
  segment are correctly relative, so this is an in-place addition that moves no offsets.

## License and credits

**AGPL-3.0** — see [LICENSE](./LICENSE). The server bundles
[`@animegarden/client`](https://www.npmjs.com/package/@animegarden/client), which is AGPL-3.0, so
the combined work inherits it. [NOTICE.md](./NOTICE.md) has the full dependency breakdown.

Release data from [Anime Garden](https://animes.garden), title parsing by
[anipar](https://www.npmjs.com/package/anipar), metadata and cover art from
[Bangumi 番组计划](https://bgm.tv). Haro is a client for these services and does not operate them.

Haro is a character from *Mobile Suit Gundam*, owned by Sotsu and Sunrise. This project is not
affiliated with them.
