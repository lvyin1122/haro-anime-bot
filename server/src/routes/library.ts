import { Hono } from 'hono';
import { join } from 'node:path';

import * as jellyfin from '../clients/jellyfin.ts';
import { getSubject, mainEpisodes } from '../clients/bangumi.ts';
import { config, playerMode } from '../config.ts';
import {
  downloads,
  importedFiles,
  playbackProgress,
  subscriptions,
  type Subscription
} from '../data.ts';
import { seasonFolderName } from '../core/naming.ts';
import { pathExists } from '../core/paths.ts';
import { errorMessage } from '../log.ts';

/**
 * Whether an imported episode is actually playable yet.
 *
 * What `ready` means depends on who is doing the playing. With the built-in
 * player it means the file is on disk, which is all it needs. With Jellyfin it
 * means Jellyfin has an item id for it — hence `pending-scan`, the normal
 * transient state right after an import, where the fix is a library scan
 * rather than a re-download.
 */
export type ReadyState = 'ready' | 'pending-scan' | 'unavailable';

export interface ReadyItem {
  downloadId: number;
  subscriptionId?: number;
  seriesTitle: string;
  season: number;
  episode: number;
  episodeTitle?: string;
  importedAt?: number;
  libraryPath?: string;
  /** `imported_files.id` — what the built-in player addresses episodes by. */
  fileId?: number;
  state: ReadyState;
  itemId?: string;
  played: boolean;
  playedPercentage?: number;
}

async function resolveSeriesItemId(subscription: Subscription): Promise<string | undefined> {
  const seriesPath = join(config.LIBRARY_ROOT, subscription.libraryFolder);
  return (await jellyfin.findSeries(seriesPath, subscription.title))?.Id;
}

/**
 * The video we hardlinked for a download.
 *
 * A batch torrent imports several episodes under one download id but the
 * download row records only the first episode number, so this returns the
 * first video row to match — the rest are reachable through the download
 * detail endpoint.
 */
function videoFor(downloadId: number) {
  return importedFiles.videosFor(downloadId)[0];
}

/**
 * Fill in playability and watched state from local sources alone.
 *
 * The file being on disk is the whole of "playable" for the built-in player,
 * and `playback_progress` is where it records how far you got — so nothing
 * here touches the network, and an episode is watchable the instant it lands
 * rather than whenever an external scan gets round to it.
 */
async function resolveLocally(items: ReadyItem[]): Promise<ReadyItem[]> {
  const fileIds = items.map((item) => item.fileId).filter((id): id is number => id !== undefined);
  const progress = playbackProgress.forFiles(fileIds);

  await Promise.all(
    items.map(async (item) => {
      if (!item.libraryPath || !(await pathExists(item.libraryPath))) {
        item.state = 'unavailable';
        return;
      }
      item.state = 'ready';

      const saved = item.fileId === undefined ? undefined : progress.get(item.fileId);
      if (!saved) return;
      item.played = saved.played;
      if (saved.durationMs && saved.durationMs > 0) {
        item.playedPercentage = (saved.positionMs / saved.durationMs) * 100;
      }
    })
  );

  return items;
}

async function buildReadyItems(limit: number): Promise<{
  items: ReadyItem[];
  error?: string;
}> {
  const imported = downloads
    .list({ status: ['imported'], limit })
    .filter((download) => download.episode !== undefined);

  if (imported.length === 0) return { items: [] };

  // Bangumi episode titles, one cached lookup per distinct subscription.
  const subjectTitles = new Map<number, Map<number, string>>();

  const base: ReadyItem[] = [];
  for (const download of imported) {
    const subscription = download.subscriptionId
      ? subscriptions.find(download.subscriptionId)
      : undefined;

    const season = download.season ?? subscription?.season ?? 1;
    const episode = download.episode!;

    if (subscription && !subjectTitles.has(subscription.subjectId)) {
      const subject = await getSubject(subscription.subjectId).catch(() => undefined);
      subjectTitles.set(
        subscription.subjectId,
        new Map(
          subject
            ? mainEpisodes(subject).map((e) => [e.ep, e.name_cn?.trim() || e.name] as const)
            : []
        )
      );
    }

    const video = videoFor(download.id);
    base.push({
      downloadId: download.id,
      subscriptionId: subscription?.id,
      seriesTitle: subscription?.title ?? download.title,
      season,
      episode,
      episodeTitle: subscription
        ? subjectTitles.get(subscription.subjectId)?.get(Math.floor(episode))
        : undefined,
      importedAt: download.importedAt,
      libraryPath: video?.libraryPath,
      fileId: video?.id,
      state: 'unavailable',
      played: false
    });
  }

  if (playerMode() === 'builtin') return { items: await resolveLocally(base) };

  if (!config.JELLYFIN_API_KEY || !config.JELLYFIN_USER_ID) {
    return {
      items: base,
      error:
        'PLAYER_MODE is jellyfin but JELLYFIN_API_KEY / JELLYFIN_USER_ID are not set. ' +
        'Set them, or switch to PLAYER_MODE=builtin to play episodes here.'
    };
  }

  // One series lookup and one episode listing per distinct (subscription, season).
  try {
    const groups = new Map<string, ReadyItem[]>();
    for (const item of base) {
      if (item.subscriptionId === undefined) continue;
      const key = `${item.subscriptionId}:${item.season}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(item);
      else groups.set(key, [item]);
    }

    for (const [key, items] of groups) {
      const subscriptionId = Number(key.split(':')[0]);
      const subscription = subscriptions.find(subscriptionId);
      if (!subscription) continue;

      const seriesItemId = await resolveSeriesItemId(subscription);
      if (!seriesItemId) {
        for (const item of items) item.state = 'pending-scan';
        continue;
      }

      const episodes = await jellyfin.seasonEpisodes(seriesItemId, items[0]!.season);
      for (const item of items) {
        const match = jellyfin.matchEpisode(episodes, item.libraryPath, item.episode);
        if (!match) {
          item.state = 'pending-scan';
          continue;
        }
        item.state = 'ready';
        item.itemId = match.Id;
        item.played = Boolean(match.UserData?.Played);
        item.playedPercentage = match.UserData?.PlayedPercentage;
        if (!item.episodeTitle && match.Name) item.episodeTitle = match.Name;
      }
    }

    return { items: base };
  } catch (error) {
    // Jellyfin being down must not blank the page — the episodes are still on
    // disk, we just cannot say whether they are playable.
    const detail = errorMessage(error);
    return {
      items: base,
      error:
        detail === 'fetch failed'
          ? `Could not reach Jellyfin at ${config.JELLYFIN_URL}. The episodes below are in your library; Haro just cannot confirm Jellyfin has indexed them.`
          : `Jellyfin lookup failed: ${detail}`
    };
  }
}

export const libraryRoutes = new Hono()
  /**
   * Everything imported and (usually) playable, newest first. Drives the
   * "Ready to watch" list and every Play button.
   */
  .get('/ready', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 40), 200);
    const { items, error } = await buildReadyItems(limit);

    return c.json({
      items: items.sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0)),
      // Browser-facing base. Null means "derive it from the current hostname".
      publicUrl: config.JELLYFIN_PUBLIC_URL ?? null,
      serverId: (await jellyfin.serverId()) ?? null,
      jellyfinConfigured: Boolean(config.JELLYFIN_API_KEY && config.JELLYFIN_USER_ID),
      playerMode: playerMode(),
      error: error ?? null
    });
  })

  /** Resolve one download on demand — used to re-check after a scan. */
  .get('/episode/:downloadId', async (c) => {
    const downloadId = Number(c.req.param('downloadId'));
    const download = downloads.find(downloadId);
    if (!download) return c.json({ error: 'Not found' }, 404);

    const { items, error } = await buildReadyItems(200);
    const match = items.find((item) => item.downloadId === downloadId);

    return c.json({
      item: match ?? null,
      publicUrl: config.JELLYFIN_PUBLIC_URL ?? null,
      serverId: (await jellyfin.serverId()) ?? null,
      playerMode: playerMode(),
      error: error ?? null
    });
  })

  /**
   * Ask Jellyfin to scan, then forget cached series ids so the next /ready
   * call reflects whatever the scan picked up.
   */
  .post('/rescan', async (c) => {
    try {
      await jellyfin.refreshNow();
      jellyfin.invalidateSeriesCache();
      return c.json({
        ok: true,
        detail: 'Jellyfin scan started. Newly imported episodes appear once it finishes.'
      });
    } catch (error) {
      return c.json({ ok: false, detail: errorMessage(error) }, 502);
    }
  })

  /** Where a subscription's files live, for the "show me on disk" case. */
  .get('/paths/:subscriptionId', (c) => {
    const subscription = subscriptions.find(Number(c.req.param('subscriptionId')));
    if (!subscription) return c.json({ error: 'Not found' }, 404);

    const seriesDir = join(config.LIBRARY_ROOT, subscription.libraryFolder);
    return c.json({
      seriesDir,
      seasonDir: join(seriesDir, seasonFolderName(subscription.season))
    });
  });
