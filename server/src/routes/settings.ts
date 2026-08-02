import { Hono } from 'hono';

import * as jellyfin from '../clients/jellyfin.ts';
import * as qb from '../clients/qbittorrent.ts';
import { config, configWarnings } from '../config.ts';
import { recentEvents } from '../data.ts';
import { probeHardlink } from '../core/paths.ts';
import { pollAll } from '../core/scheduler.ts';
import { errorMessage } from '../log.ts';

export const settingsRoutes = new Hono()
  /** Effective configuration. Secrets are reported as set/unset, never echoed. */
  .get('/', (c) =>
    c.json({
      config: {
        downloadRoot: config.DOWNLOAD_ROOT,
        libraryRoot: config.LIBRARY_ROOT,
        qbDownloadRoot: config.QB_DOWNLOAD_ROOT,
        dataDir: config.DATA_DIR,
        qbittorrentUrl: config.QBITTORRENT_URL,
        qbittorrentUsername: config.QBITTORRENT_USERNAME,
        qbittorrentPasswordSet: Boolean(config.QBITTORRENT_PASSWORD),
        qbittorrentCategory: config.QBITTORRENT_CATEGORY,
        jellyfinUrl: config.JELLYFIN_URL,
        jellyfinPublicUrl: config.JELLYFIN_PUBLIC_URL ?? null,
        jellyfinApiKeySet: Boolean(config.JELLYFIN_API_KEY),
        jellyfinUserIdSet: Boolean(config.JELLYFIN_USER_ID),
        animegardenApi: config.ANIMEGARDEN_API,
        bangumiApi: config.BANGUMI_API,
        pollIntervalMinutes: config.POLL_INTERVAL_MINUTES,
        monitorIntervalSeconds: config.MONITOR_INTERVAL_SECONDS,
        timezone: config.TZ
      },
      warnings: configWarnings()
    })
  )

  /** Filesystem diagnostics — the check that catches most first-run failures. */
  .get('/paths', async (c) => c.json({ hardlink: await probeHardlink() }))

  .post('/test/qbittorrent', async (c) => {
    qb.resetSession();
    try {
      const version = await qb.version();
      const torrents = await qb.listTorrents({ category: config.QBITTORRENT_CATEGORY });
      return c.json({
        ok: true,
        detail: `Connected. qBittorrent ${version}, ${torrents.length} torrent(s) in category "${config.QBITTORRENT_CATEGORY}".`
      });
    } catch (error) {
      return c.json({ ok: false, detail: errorMessage(error) });
    }
  })

  .post('/test/jellyfin', async (c) => {
    try {
      const info = await jellyfin.publicInfo();
      if (!config.JELLYFIN_API_KEY) {
        return c.json({
          ok: false,
          detail: `Reachable (${info.ServerName} ${info.Version}) but JELLYFIN_API_KEY is not set.`
        });
      }

      const folders = await jellyfin.getVirtualFolders();
      const readiness = jellyfin.describeNfoReadiness(folders, config.LIBRARY_ROOT);

      if (!readiness.library) {
        return c.json({
          ok: false,
          detail:
            `Connected to ${info.ServerName} ${info.Version}, but no Jellyfin library covers ` +
            `${config.LIBRARY_ROOT}. Add it as a Shows library in Jellyfin.`,
          libraries: folders.map((f) => ({ name: f.Name, locations: f.Locations }))
        });
      }

      return c.json({
        ok: readiness.nfoEnabled,
        detail: readiness.nfoEnabled
          ? `Connected to ${info.ServerName} ${info.Version}. Library "${readiness.library}" reads local NFO files.`
          : `Library "${readiness.library}" has the local NFO reader disabled — Jellyfin will ignore the metadata we write. ` +
            `Enable "Nfo" under that library's metadata readers.`,
        onlineFetchers: readiness.onlineFetchers
      });
    } catch (error) {
      return c.json({ ok: false, detail: errorMessage(error) });
    }
  })

  .post('/jellyfin/refresh', async (c) => {
    try {
      await jellyfin.refreshNow();
      return c.json({ ok: true, detail: 'Jellyfin library scan started.' });
    } catch (error) {
      return c.json({ ok: false, detail: errorMessage(error) }, 502);
    }
  })

  /** Check every subscription now instead of waiting for the next tick. */
  .post('/scan', async (c) => c.json({ results: await pollAll() }))

  .get('/events', (c) => c.json({ events: recentEvents(Number(c.req.query('limit') ?? 100)) }));
