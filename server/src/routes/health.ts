import { Hono } from 'hono';

import { config, configWarnings, playerMode } from '../config.ts';
import * as animegarden from '../clients/animegarden.ts';
import * as bangumi from '../clients/bangumi.ts';
import * as jellyfin from '../clients/jellyfin.ts';
import * as qbittorrent from '../clients/qbittorrent.ts';
import { ffmpegVersion } from '../core/ffmpeg.ts';
import { probeHardlink } from '../core/paths.ts';
import { errorMessage } from '../log.ts';

export interface ServiceStatus {
  name: string;
  ok: boolean;
  detail: string;
}

async function check(name: string, probe: () => Promise<string>): Promise<ServiceStatus> {
  try {
    return { name, ok: true, detail: await probe() };
  } catch (error) {
    return { name, ok: false, detail: errorMessage(error) };
  }
}

export const healthRoutes = new Hono()
  // Dependency-free: answers even when every upstream is down, so an unhealthy
  // container means the app itself is broken rather than qBittorrent being off.
  .get('/live', (c) => c.json({ status: 'ok' }))

  .get('/', async (c) => {
    const mode = playerMode();

    const [qb, player, ag, bgm, links] = await Promise.all([
      check('qBittorrent', async () => `connected, version ${await qbittorrent.version()}`),
      // Whichever of the two is actually responsible for playback. Reporting
      // an unconfigured Jellyfin as a failure would leave every built-in-player
      // instance permanently degraded over a service it does not use.
      mode === 'jellyfin'
        ? check('Jellyfin', async () => {
            const info = await jellyfin.publicInfo();
            if (!config.JELLYFIN_API_KEY) {
              throw new Error(`reachable (${info.ServerName}) but JELLYFIN_API_KEY is not set`);
            }
            const folders = await jellyfin.getVirtualFolders();
            const readiness = jellyfin.describeNfoReadiness(folders, config.LIBRARY_ROOT);
            if (!readiness.library) {
              return `connected to ${info.ServerName} ${info.Version}; no library covers ${config.LIBRARY_ROOT} yet`;
            }
            return `connected to ${info.ServerName} ${info.Version}; library "${readiness.library}"${
              readiness.nfoEnabled ? '' : ' — WARNING: local NFO reader is disabled'
            }`;
          })
        : check('Player', async () => `built-in player, ffmpeg ${await ffmpegVersion()}`),
      check('AnimeGarden', async () => {
        if (!(await animegarden.ping())) throw new Error('API returned an error');
        return `reachable at ${config.ANIMEGARDEN_API}`;
      }),
      check('Bangumi', async () => {
        const days = await bangumi.getCalendar();
        return `reachable, ${days.reduce((n, d) => n + d.items.length, 0)} shows airing this week`;
      }),
      probeHardlink()
    ]);

    const services = [qb, player, ag, bgm];
    const ok = services.every((s) => s.ok) && links.ok;

    return c.json(
      {
        status: ok ? 'ok' : 'degraded',
        playerMode: mode,
        services,
        paths: {
          downloadRoot: config.DOWNLOAD_ROOT,
          libraryRoot: config.LIBRARY_ROOT,
          qbDownloadRoot: config.QB_DOWNLOAD_ROOT,
          dataDir: config.DATA_DIR,
          hardlink: links
        },
        warnings: configWarnings()
      },
      ok ? 200 : 503
    );
  });
