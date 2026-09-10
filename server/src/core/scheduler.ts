import { isEpisodeType, queryResources, type AgResource } from '../clients/animegarden.ts';
import * as qb from '../clients/qbittorrent.ts';
import { config } from '../config.ts';
import { downloads, subscriptions, type Download, type Subscription } from '../data.ts';
import { errorMessage, log } from '../log.ts';
import { importDownload } from './importer.ts';
import { fullMagnet, infoHashFromMagnet } from './infohash.ts';
import { applyOffset, parseRelease } from './naming.ts';
import { mapToQbPath } from './paths.ts';

/** Guards against a slow run overlapping the next tick. */
let polling = false;
let monitoring = false;

const timers: NodeJS.Timeout[] = [];

export interface PollResult {
  subscriptionId: number;
  found: number;
  queued: number;
  skipped: number;
  errors: string[];
}

function subscriptionTag(subscription: Subscription): string {
  return `haro:sub:${subscription.id}`;
}

/**
 * Queue one resource for download.
 * Returns false when it was a duplicate or otherwise not actionable.
 */
async function enqueue(
  resource: AgResource,
  subscription: Subscription,
  claimed: Set<number>
): Promise<boolean> {
  const infoHash = infoHashFromMagnet(resource.magnet);
  if (!infoHash) {
    log.warn('poller', `could not read an infohash from "${resource.title}"`, {
      magnet: resource.magnet.slice(0, 80)
    });
    return false;
  }

  if (downloads.findByInfoHash(infoHash)) return false;

  // Soundtracks and art books share a Bangumi subject with the show itself.
  if (!isEpisodeType(resource.type)) return false;

  const parsed = parseRelease(resource.title);
  if (parsed.episode === undefined) {
    log.info('poller', `no episode number in "${resource.title}", ignoring`, {
      subscriptionId: subscription.id
    });
    return false;
  }

  const episode = applyOffset(parsed.episode, subscription.episodeOffset);

  // A batch release still earns its place if it covers episodes we lack.
  const isBatch = parsed.episodeTo !== undefined && parsed.episodeTo > parsed.episode;
  if (!isBatch && claimed.has(episode)) return false;

  const record = downloads.create({
    subscriptionId: subscription.id,
    resourceId: resource.id,
    provider: resource.provider,
    providerId: resource.providerId,
    title: resource.title,
    magnet: resource.magnet,
    infoHash,
    size: resource.size,
    fansub: resource.fansub?.name,
    season: subscription.season,
    episode,
    episodeTo:
      parsed.episodeTo === undefined
        ? undefined
        : applyOffset(parsed.episodeTo, subscription.episodeOffset),
    status: 'queued',
    // Surfaced as a badge in the UI; it does not block the download.
    needsReview: parsed.lowConfidence,
    addedAt: Date.now()
  });

  try {
    await qb.ensureCategory(config.QBITTORRENT_CATEGORY);
    await qb.addTorrent({
      magnet: fullMagnet(resource.magnet, resource.tracker),
      savepath: mapToQbPath(`${config.DOWNLOAD_ROOT}/${subscription.libraryFolder}`),
      category: config.QBITTORRENT_CATEGORY,
      tags: [subscriptionTag(subscription)]
    });

    downloads.update(record.id, { status: 'downloading' });
    claimed.add(episode);

    log.info('poller', `queued E${episode} — ${resource.title}`, {
      subscriptionId: subscription.id,
      downloadId: record.id,
      infoHash
    });
    return true;
  } catch (error) {
    downloads.update(record.id, { status: 'failed', error: errorMessage(error) });
    log.error('poller', `failed to add "${resource.title}" to qBittorrent`, {
      error: errorMessage(error)
    });
    return false;
  }
}

/**
 * Check one subscription for new releases.
 *
 * This queries the same data AnimeGarden's feed.xml is generated from, but as
 * structured JSON — the `after` cursor gives us exactly what has appeared
 * since the last run instead of re-reading a fixed-length feed window.
 */
export async function pollSubscription(
  subscription: Subscription,
  options: { backfill?: boolean; force?: boolean } = {}
): Promise<PollResult> {
  const result: PollResult = {
    subscriptionId: subscription.id,
    found: 0,
    queued: 0,
    skipped: 0,
    errors: []
  };

  try {
    const after =
      !options.backfill && subscription.cursorAt ? new Date(subscription.cursorAt) : undefined;

    const { resources } = await queryResources({
      subject: subscription.subjectId,
      ...subscription.filter,
      ...(after ? { after } : {}),
      count: -1,
      pageSize: 100
    });

    result.found = resources.length;

    const claimed = downloads.claimedEpisodes(subscription.id);
    let newest = subscription.cursorAt ?? 0;

    // Oldest first, so episodes are queued in broadcast order.
    const ordered = [...resources].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    for (const resource of ordered) {
      newest = Math.max(newest, new Date(resource.createdAt).getTime());

      // `force` is the "download everything now" button: a subscription with
      // auto-download off is one you want to pick from by hand, but asking for
      // the back catalogue outright is an explicit instruction that outranks
      // that preference for this one run.
      if (!subscription.autoDownload && !options.force) {
        result.skipped++;
        continue;
      }
      if (await enqueue(resource, subscription, claimed)) result.queued++;
      else result.skipped++;
    }

    // The cursor means "everything published up to here has been considered",
    // which is true whether or not anything was queued from it.
    subscriptions.update(subscription.id, {
      lastCheckedAt: Date.now(),
      ...(newest > 0 ? { cursorAt: newest } : {})
    });
  } catch (error) {
    const message = errorMessage(error);
    result.errors.push(message);
    log.error('poller', `subscription "${subscription.title}" failed`, { error: message });
    subscriptions.update(subscription.id, { lastCheckedAt: Date.now() });
  }

  return result;
}

export async function pollAll(): Promise<PollResult[]> {
  if (polling) {
    log.info('poller', 'previous run still in progress, skipping this tick');
    return [];
  }
  polling = true;

  try {
    const enabled = subscriptions.listEnabled();
    const results: PollResult[] = [];
    // Sequential on purpose: a Pi has little to gain from parallel HTTP here,
    // and AnimeGarden should not see a burst on every tick.
    for (const subscription of enabled) {
      results.push(await pollSubscription(subscription));
    }

    const queued = results.reduce((n, r) => n + r.queued, 0);
    if (queued > 0) log.info('poller', `queued ${queued} new episode(s)`);

    return results;
  } finally {
    polling = false;
  }
}

/** Import a finished download, recording any failure against the row. */
async function tryImport(download: Download): Promise<void> {
  const subscription = download.subscriptionId
    ? subscriptions.find(download.subscriptionId)
    : undefined;

  if (!subscription) {
    downloads.update(download.id, {
      status: 'failed',
      error: 'Subscription no longer exists; nothing to import into.'
    });
    return;
  }

  downloads.update(download.id, { status: 'importing' });
  try {
    await importDownload({ ...download, status: 'importing' }, subscription);
  } catch (error) {
    const message = errorMessage(error);
    downloads.update(download.id, { status: 'failed', error: message });
    log.error('importer', `import failed for "${download.title}"`, {
      downloadId: download.id,
      error: message
    });
  }
}

/** Poll qBittorrent for progress and import whatever has finished. */
export async function monitorDownloads(): Promise<void> {
  if (monitoring) return;
  monitoring = true;

  try {
    const active = downloads.active();
    if (active.length === 0) return;

    const torrents = await qb.listTorrents({ hashes: active.map((d) => d.infoHash) });
    const byHash = new Map(torrents.map((t) => [t.hash.toLowerCase(), t]));

    for (const download of active) {
      const torrent = byHash.get(download.infoHash);

      if (!torrent) {
        // Removed from qBittorrent behind our back. Leave already-imported
        // rows alone and mark the rest so the UI can explain the gap.
        if (download.status !== 'importing') {
          downloads.update(download.id, {
            status: 'failed',
            error: 'Torrent is no longer present in qBittorrent.'
          });
        }
        continue;
      }

      downloads.update(download.id, {
        qbState: torrent.state,
        qbProgress: torrent.progress,
        contentPath: torrent.content_path
      });

      if (!qb.isComplete(torrent)) {
        if (download.status === 'queued') downloads.update(download.id, { status: 'downloading' });
        continue;
      }

      if (download.status === 'importing') continue;

      downloads.update(download.id, {
        status: 'completed',
        completedAt: torrent.completion_on * 1000
      });

      await tryImport({
        ...download,
        status: 'completed',
        contentPath: torrent.content_path
      });
    }
  } catch (error) {
    log.error('monitor', 'qBittorrent poll failed', { error: errorMessage(error) });
  } finally {
    monitoring = false;
  }
}

export function startScheduler(): void {
  const pollMs = config.POLL_INTERVAL_MINUTES * 60_000;
  const monitorMs = config.MONITOR_INTERVAL_SECONDS * 1000;

  // Stagger the first runs so boot does not fire every job at once.
  timers.push(setTimeout(() => void monitorDownloads(), 10_000));
  timers.push(setTimeout(() => void pollAll(), 30_000));

  timers.push(setInterval(() => void pollAll(), pollMs));
  timers.push(setInterval(() => void monitorDownloads(), monitorMs));

  log.info(
    'scheduler',
    `polling subscriptions every ${config.POLL_INTERVAL_MINUTES}m, qBittorrent every ${config.MONITOR_INTERVAL_SECONDS}s`
  );
}

export function stopScheduler(): void {
  for (const timer of timers) clearTimeout(timer as unknown as NodeJS.Timeout);
  timers.length = 0;
}
