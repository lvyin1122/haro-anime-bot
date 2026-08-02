import { Hono } from 'hono';
import { z } from 'zod';

import * as qb from '../clients/qbittorrent.ts';
import { config } from '../config.ts';
import { downloads, importedFiles, subscriptions, type DownloadStatus } from '../data.ts';
import { fullMagnet, infoHashFromMagnet } from '../core/infohash.ts';
import { importDownload } from '../core/importer.ts';
import { parseRelease } from '../core/naming.ts';
import { mapToQbPath } from '../core/paths.ts';
import { monitorDownloads } from '../core/scheduler.ts';
import { errorMessage, log } from '../log.ts';

const STATUSES = [
  'queued',
  'downloading',
  'completed',
  'importing',
  'imported',
  'failed',
  'skipped'
] as const;

const ManualAddSchema = z.object({
  magnet: z.string().trim().min(1),
  tracker: z.string().trim().optional(),
  title: z.string().trim().min(1),
  subscriptionId: z.number().int().positive().optional(),
  episode: z.number().min(0).max(2000).optional(),
  resourceId: z.number().int().optional(),
  provider: z.string().trim().optional(),
  providerId: z.string().trim().optional(),
  size: z.number().int().optional(),
  fansub: z.string().trim().optional()
});

export const downloadRoutes = new Hono()
  .get('/', (c) => {
    const statusParam = c.req.queries('status') ?? [];
    const status = statusParam.filter((s): s is DownloadStatus =>
      (STATUSES as readonly string[]).includes(s)
    );
    const subscriptionId = c.req.query('subscriptionId');

    return c.json({
      downloads: downloads.list({
        ...(status.length ? { status } : {}),
        ...(subscriptionId ? { subscriptionId: Number(subscriptionId) } : {}),
        limit: Number(c.req.query('limit') ?? 200)
      })
    });
  })

  .get('/:id', (c) => {
    const download = downloads.find(Number(c.req.param('id')));
    if (!download) return c.json({ error: 'Not found' }, 404);
    return c.json({ download, files: importedFiles.forDownload(download.id) });
  })

  /** Grab a specific release by hand, from the anime detail page. */
  .post('/', async (c) => {
    const parsed = ManualAddSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const input = parsed.data;
    const infoHash = infoHashFromMagnet(input.magnet);
    if (!infoHash) {
      return c.json({ error: 'Could not read an infohash from that magnet link' }, 400);
    }

    const existing = downloads.findByInfoHash(infoHash);
    if (existing) return c.json({ download: existing, alreadyQueued: true });

    const subscription = input.subscriptionId
      ? subscriptions.find(input.subscriptionId)
      : undefined;

    if (input.subscriptionId && !subscription) {
      return c.json({ error: 'Subscription not found' }, 404);
    }

    const release = parseRelease(input.title);
    const episode =
      input.episode ??
      (release.episode === undefined
        ? undefined
        : release.episode - (subscription?.episodeOffset ?? 0));

    const record = downloads.create({
      subscriptionId: subscription?.id,
      resourceId: input.resourceId,
      provider: input.provider,
      providerId: input.providerId,
      title: input.title,
      magnet: input.magnet,
      infoHash,
      size: input.size,
      fansub: input.fansub ?? release.fansub,
      season: subscription?.season,
      episode,
      episodeTo: release.episodeTo,
      status: 'queued',
      needsReview: release.lowConfidence || episode === undefined,
      addedAt: Date.now()
    });

    // Without a subscription there is no library folder to file it under, so
    // it lands in the category root and is left for manual handling.
    const savepath = subscription
      ? mapToQbPath(`${config.DOWNLOAD_ROOT}/${subscription.libraryFolder}`)
      : mapToQbPath(config.DOWNLOAD_ROOT);

    try {
      await qb.ensureCategory(config.QBITTORRENT_CATEGORY);
      await qb.addTorrent({
        magnet: fullMagnet(input.magnet, input.tracker),
        savepath,
        category: config.QBITTORRENT_CATEGORY,
        tags: subscription ? [`haro:sub:${subscription.id}`] : ['haro:manual']
      });
      downloads.update(record.id, { status: 'downloading' });
      log.info('downloads', `manually queued "${input.title}"`, { downloadId: record.id });
    } catch (error) {
      const message = errorMessage(error);
      downloads.update(record.id, { status: 'failed', error: message });
      return c.json({ error: message, download: downloads.find(record.id) }, 502);
    }

    return c.json({ download: downloads.find(record.id) }, 201);
  })

  /** Re-run the import for something that downloaded but failed to file. */
  .post('/:id/import', async (c) => {
    const download = downloads.find(Number(c.req.param('id')));
    if (!download) return c.json({ error: 'Not found' }, 404);

    const subscription = download.subscriptionId
      ? subscriptions.find(download.subscriptionId)
      : undefined;
    if (!subscription) {
      return c.json({ error: 'This download has no subscription to import into' }, 400);
    }

    try {
      const result = await importDownload(download, subscription);
      return c.json({ result, download: downloads.find(download.id) });
    } catch (error) {
      const message = errorMessage(error);
      downloads.update(download.id, { status: 'failed', error: message });
      return c.json({ error: message }, 500);
    }
  })

  /** Re-add a failed torrent to qBittorrent. */
  .post('/:id/retry', async (c) => {
    const download = downloads.find(Number(c.req.param('id')));
    if (!download) return c.json({ error: 'Not found' }, 404);

    const subscription = download.subscriptionId
      ? subscriptions.find(download.subscriptionId)
      : undefined;

    try {
      await qb.ensureCategory(config.QBITTORRENT_CATEGORY);
      await qb.addTorrent({
        magnet: download.magnet,
        savepath: subscription
          ? mapToQbPath(`${config.DOWNLOAD_ROOT}/${subscription.libraryFolder}`)
          : mapToQbPath(config.DOWNLOAD_ROOT),
        category: config.QBITTORRENT_CATEGORY,
        tags: subscription ? [`haro:sub:${subscription.id}`] : ['haro:manual']
      });
      downloads.update(download.id, { status: 'downloading', error: undefined, qbProgress: 0 });
      return c.json({ download: downloads.find(download.id) });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  })

  /**
   * Forget a download. `removeTorrent`/`deleteFiles` are opt-in — the default
   * only clears our record, because deleting a seeding torrent or its data is
   * not something to do implicitly.
   */
  .delete('/:id', async (c) => {
    const download = downloads.find(Number(c.req.param('id')));
    if (!download) return c.json({ error: 'Not found' }, 404);

    const removeTorrent = c.req.query('removeTorrent') === 'true';
    const deleteFiles = c.req.query('deleteFiles') === 'true';

    if (removeTorrent) {
      try {
        await qb.deleteTorrent(download.infoHash, deleteFiles);
      } catch (error) {
        return c.json({ error: errorMessage(error) }, 502);
      }
    }

    downloads.remove(download.id);
    return c.json({ ok: true });
  })

  /** Kick the monitor immediately rather than waiting for the next tick. */
  .post('/refresh', async (c) => {
    await monitorDownloads();
    return c.json({ downloads: downloads.list({ limit: 200 }) });
  });
