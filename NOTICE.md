# Third-party notices

Haro is licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](./LICENSE).

## Why AGPL

The server bundle (`server/dist/index.js`) is produced by esbuild with dependencies inlined, and one
of them is copyleft:

| Dependency | License | Role |
| --- | --- | --- |
| [`@animegarden/client`](https://www.npmjs.com/package/@animegarden/client) | **AGPL-3.0** | Typed client for the Anime Garden resource API |
| [`anipar`](https://www.npmjs.com/package/anipar) | MIT | Parses season/episode/fansub out of release titles |
| [`hono`](https://hono.dev) | MIT | HTTP router |
| [`zod`](https://zod.dev) | MIT | Environment and request validation |
| [`react`](https://react.dev), [`@tanstack/*`](https://tanstack.com), [`tailwindcss`](https://tailwindcss.com), [`lucide-react`](https://lucide.dev) | MIT / ISC | Web UI |
| [`hls.js`](https://github.com/video-dev/hls.js) | Apache-2.0 | Plays the segmented stream the built-in player produces |
| [`jassub`](https://github.com/ThaUnknown/jassub) | MIT, wrapping [libass](https://github.com/libass/libass) (ISC) | Renders ASS/SSA subtitles in the browser |

Because `@animegarden/client` is AGPL-3.0 and is combined into the distributed bundle, the combined
work is licensed under the AGPL as well.

AGPL §13 additionally extends to network use: anyone interacting with a hosted instance over a
network is entitled to its source. For a LAN-only deployment serving its own operator there is
nobody to make that request, but the obligation is worth knowing about before exposing an instance
publicly.

## Data sources

Haro is a client for services it does not operate. Please use them considerately — Bangumi in
particular is a community-run service, so requests are throttled and responses cached locally.

- **[Anime Garden](https://animes.garden)** ([source](https://github.com/yjl9903/AnimeGarden),
  AGPL-3.0) — a third-party mirror of [動漫花園](https://share.dmhy.org/) and an aggregator of anime
  BT resources. Haro reads its public API for release listings.
- **[Bangumi 番组计划](https://bgm.tv)** — anime metadata, episode lists, airing calendar and cover
  art. Fetched via its public API with a descriptive `User-Agent`, as its guidelines request.

The runtime image also installs **ffmpeg** (LGPL-2.1-or-later as built by Alpine, with GPL-licensed
components including x264 and x265). It is invoked as a separate program rather than linked, and is
not modified or redistributed by this project beyond the distribution's own package.

Cover art and synopses fetched from Bangumi and written into your library remain the property of
their respective rights holders; they are cached locally for personal media organization.

**Haro** is a character from *Mobile Suit Gundam*, owned by Sotsu and Sunrise. The name and the
spherical green mark used in this interface are a fan homage; this project is not affiliated with,
endorsed by, or licensed from either company.

The `AnimeGarden/` directory, if present in a working copy, is a separate upstream checkout kept for
API reference. It is excluded from version control and from the Docker build, and is not
redistributed as part of this project.
