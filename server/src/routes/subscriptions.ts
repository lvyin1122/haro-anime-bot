import { Hono } from 'hono';
import { z } from 'zod';

import { queryResources } from '../clients/animegarden.ts';
import { displayTitle, getSubject, mainEpisodes, subjectYear } from '../clients/bangumi.ts';
import { downloads, subscriptions } from '../data.ts';
import { parseRelease, sanitizeName, seriesFolderName } from '../core/naming.ts';
import { pollSubscription } from '../core/scheduler.ts';

const stringList = z.array(z.string().trim().min(1)).max(20).default([]);

const FilterSchema = z.object({
  fansubs: stringList,
  include: stringList,
  keywords: stringList,
  exclude: stringList,
  types: stringList,
  search: stringList
});

const CreateSchema = z.object({
  subjectId: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  season: z.number().int().min(0).max(99).default(1),
  episodeOffset: z.number().int().min(-500).max(500).default(0),
  filter: FilterSchema.partial().default({}),
  libraryFolder: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().default(true),
  autoDownload: z.boolean().default(true),
  /** How far back to look on the first poll. Omit to start from now. */
  backfillDays: z.number().int().min(0).max(365).default(0)
});

const UpdateSchema = CreateSchema.partial().omit({ subjectId: true, backfillDays: true });

const PreviewSchema = z.object({
  subjectId: z.number().int().positive(),
  filter: FilterSchema.partial().default({}),
  episodeOffset: z.number().int().min(-500).max(500).default(0),
  limit: z.number().int().min(1).max(100).default(30)
});

export const subscriptionRoutes = new Hono()
  .get('/', (c) => {
    const list = subscriptions.list().map((subscription) => {
      const rows = downloads.list({ subscriptionId: subscription.id, limit: 500 });
      const imported = rows.filter((d) => d.status === 'imported');
      const active = rows.filter((d) => d.status === 'downloading' || d.status === 'queued');

      return {
        ...subscription,
        stats: {
          total: rows.length,
          imported: imported.length,
          active: active.length,
          failed: rows.filter((d) => d.status === 'failed').length,
          latestEpisode: imported.reduce<number | undefined>(
            (max, d) =>
              d.episode !== undefined && (max === undefined || d.episode > max) ? d.episode : max,
            undefined
          )
        }
      };
    });

    return c.json({ subscriptions: list });
  })

  /**
   * Dry-run a filter against AnimeGarden before saving it. This is what makes
   * the subscribe dialog honest — you see the exact releases the filter picks
   * up and the episode numbers they parse to.
   */
  .post('/preview', async (c) => {
    const parsed = PreviewSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const { subjectId, filter, episodeOffset, limit } = parsed.data;

    const { resources } = await queryResources({
      subject: subjectId,
      ...filter,
      count: -1,
      pageSize: 100
    });

    const matches = resources.slice(0, limit).map((resource) => {
      const release = parseRelease(resource.title);
      return {
        title: resource.title,
        fansub: resource.fansub?.name,
        size: resource.size,
        createdAt: resource.createdAt,
        episode: release.episode === undefined ? undefined : release.episode - episodeOffset,
        rawEpisode: release.episode,
        episodeTo: release.episodeTo,
        resolution: release.resolution,
        subtitleLanguages: release.subtitleLanguages,
        lowConfidence: release.lowConfidence
      };
    });

    const episodes = [
      ...new Set(matches.map((m) => m.episode).filter((e): e is number => e !== undefined))
    ].sort((a, b) => a - b);

    return c.json({
      total: resources.length,
      shown: matches.length,
      unparsed: matches.filter((m) => m.episode === undefined).length,
      episodes,
      matches
    });
  })

  .get('/:id', (c) => {
    const subscription = subscriptions.find(Number(c.req.param('id')));
    if (!subscription) return c.json({ error: 'Not found' }, 404);

    return c.json({
      subscription,
      downloads: downloads.list({ subscriptionId: subscription.id, limit: 500 })
    });
  })

  /** Episode grid: which episodes are in the library, pending, or unaired. */
  .get('/:id/episodes', async (c) => {
    const subscription = subscriptions.find(Number(c.req.param('id')));
    if (!subscription) return c.json({ error: 'Not found' }, 404);

    const subject = await getSubject(subscription.subjectId).catch(() => undefined);
    const rows = downloads.list({ subscriptionId: subscription.id, limit: 500 });

    const byEpisode = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      if (row.episode === undefined) continue;
      const existing = byEpisode.get(row.episode);
      // An imported row always wins over a pending or failed one.
      if (!existing || row.status === 'imported') byEpisode.set(row.episode, row);
    }

    const today = new Date().toISOString().slice(0, 10);
    const known = subject ? mainEpisodes(subject) : [];

    const episodes = known.map((episode) => {
      const download = byEpisode.get(episode.ep);
      return {
        ep: episode.ep,
        title: episode.name_cn?.trim() || episode.name,
        airdate: episode.airdate,
        aired: Boolean(episode.airdate) && episode.airdate <= today,
        status: download?.status ?? 'missing',
        downloadId: download?.id,
        progress: download?.qbProgress ?? 0,
        needsReview: download?.needsReview ?? false
      };
    });

    // Episodes we grabbed that Bangumi does not list (specials, over-runs).
    const extra = [...byEpisode.entries()]
      .filter(([ep]) => !known.some((e) => e.ep === ep))
      .map(([ep, download]) => ({
        ep,
        title: download.title,
        airdate: undefined,
        aired: true,
        status: download.status,
        downloadId: download.id,
        progress: download.qbProgress,
        needsReview: download.needsReview
      }));

    return c.json({ episodes, extra });
  })

  .post('/', async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const input = parsed.data;

    if (subscriptions.findBySubject(input.subjectId)) {
      return c.json({ error: 'A subscription for this subject already exists' }, 409);
    }

    const subject = await getSubject(input.subjectId).catch(() => undefined);
    const title = input.title ?? (subject ? displayTitle(subject) : `Subject ${input.subjectId}`);
    const libraryFolder = sanitizeName(
      input.libraryFolder ?? seriesFolderName(title, subject ? subjectYear(subject) : undefined)
    );

    const cursorAt =
      input.backfillDays > 0
        ? Date.now() - input.backfillDays * 86_400_000
        : // Start from now: a fresh subscription should not pull an entire back
          // catalogue unless explicitly asked to.
          Date.now();

    const subscription = subscriptions.create({
      subjectId: input.subjectId,
      title,
      season: input.season,
      episodeOffset: input.episodeOffset,
      filter: input.filter,
      libraryFolder,
      enabled: input.enabled,
      autoDownload: input.autoDownload,
      cursorAt
    });

    return c.json({ subscription }, 201);
  })

  .patch('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!subscriptions.find(id)) return c.json({ error: 'Not found' }, 404);

    const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const patch = { ...parsed.data };
    if (patch.libraryFolder) patch.libraryFolder = sanitizeName(patch.libraryFolder);

    return c.json({ subscription: subscriptions.update(id, patch) });
  })

  .delete('/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!subscriptions.find(id)) return c.json({ error: 'Not found' }, 404);

    // Downloads cascade; files already in the library are deliberately left
    // in place — unsubscribing is not a request to delete what you have.
    subscriptions.remove(id);
    return c.json({ ok: true });
  })

  /** Force a check now, optionally ignoring the cursor to re-scan history. */
  .post('/:id/scan', async (c) => {
    const subscription = subscriptions.find(Number(c.req.param('id')));
    if (!subscription) return c.json({ error: 'Not found' }, 404);

    const backfill = c.req.query('backfill') === 'true';
    return c.json({ result: await pollSubscription(subscription, { backfill }) });
  });
