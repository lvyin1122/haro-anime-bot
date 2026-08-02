import { Hono } from 'hono';
import { z } from 'zod';

import {
  activeSubjects,
  queryResources,
  resourceDetail,
  type AgResource
} from '../clients/animegarden.ts';
import {
  displayTitle,
  getCalendar,
  getSubject,
  mainEpisodes,
  searchSubjects,
  subjectYear
} from '../clients/bangumi.ts';
import { subscriptions } from '../data.ts';
import { parseRelease, seriesFolderName } from '../core/naming.ts';
import { infoHashFromMagnet } from '../core/infohash.ts';

/** Shape sent to the UI — parsed episode data folded in alongside the raw resource. */
function presentResource(resource: AgResource) {
  const parsed = parseRelease(resource.title);
  return {
    id: resource.id,
    provider: resource.provider,
    providerId: resource.providerId,
    title: resource.title,
    href: resource.href,
    type: resource.type,
    magnet: resource.magnet,
    tracker: resource.tracker,
    infoHash: infoHashFromMagnet(resource.magnet),
    size: resource.size,
    fansub: resource.fansub?.name,
    publisher: resource.publisher?.name,
    subjectId: resource.subjectId,
    createdAt: resource.createdAt,
    parsed: {
      episode: parsed.episode,
      episodeTo: parsed.episodeTo,
      season: parsed.season,
      resolution: parsed.resolution,
      subtitleLanguages: parsed.subtitleLanguages,
      source: parsed.source,
      lowConfidence: parsed.lowConfidence
    }
  };
}

export type PresentedResource = ReturnType<typeof presentResource>;

const SearchQuery = z.object({
  q: z.string().trim().optional(),
  subject: z.coerce.number().int().positive().optional(),
  fansub: z.string().trim().optional(),
  type: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(40)
});

export const discoverRoutes = new Hono()
  /** Free-text / filtered search over AnimeGarden resources. */
  .get('/resources', async (c) => {
    const parsed = SearchQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);

    const { q, subject, fansub, type, page, pageSize } = parsed.data;

    const { resources, complete } = await queryResources({
      ...(subject ? { subject } : {}),
      ...(q ? { search: q.split(/\s+/).filter(Boolean) } : {}),
      ...(fansub ? { fansubs: [fansub] } : {}),
      ...(type ? { types: [type] } : {}),
      page,
      pageSize
    });

    return c.json({
      resources: resources.map(presentResource),
      page,
      pageSize,
      complete
    });
  })

  /** Bangumi subject search — the entry point for subscribing to a show. */
  .get('/subjects', async (c) => {
    const keyword = c.req.query('q')?.trim();
    if (!keyword) return c.json({ subjects: [] });

    const found = await searchSubjects(keyword, 20);
    const subscribed = new Set(subscriptions.list().map((s) => s.subjectId));

    return c.json({
      subjects: found.map((s) => ({
        id: s.id,
        name: s.name,
        nameCn: s.name_cn,
        title: displayTitle(s),
        year: subjectYear(s),
        date: s.date,
        image: s.images?.common ?? s.images?.large,
        score: s.rating?.score,
        summary: s.summary?.slice(0, 300),
        subscribed: subscribed.has(s.id)
      }))
    });
  })

  /** Weekly airing calendar from Bangumi. */
  .get('/calendar', async (c) => {
    const [days, subscribed] = await Promise.all([
      getCalendar(),
      Promise.resolve(new Set(subscriptions.list().map((s) => s.subjectId)))
    ]);

    return c.json({
      days: days.map((day) => ({
        weekday: day.weekday,
        items: day.items.map((item) => ({
          id: item.id,
          title: item.name_cn?.trim() || item.name,
          name: item.name,
          image: item.images?.common ?? item.images?.large,
          score: item.rating?.score,
          subscribed: subscribed.has(item.id)
        }))
      }))
    });
  })

  /** Subjects AnimeGarden is actively indexing — "what has resources right now". */
  .get('/active', async (c) => {
    const subjects = await activeSubjects();
    const subscribed = new Set(subscriptions.list().map((s) => s.subjectId));
    return c.json({
      subjects: subjects
        .filter((s) => !s.isArchived)
        .sort((a, b) => b.activedAt.localeCompare(a.activedAt))
        .map((s) => ({ ...s, subscribed: subscribed.has(s.id) }))
    });
  })

  /** Everything the detail page needs: Bangumi metadata plus available releases. */
  .get('/anime/:subjectId', async (c) => {
    const subjectId = Number(c.req.param('subjectId'));
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      return c.json({ error: 'Invalid subject id' }, 400);
    }

    const refresh = c.req.query('refresh') === 'true';
    const subject = await getSubject(subjectId, refresh);

    const { resources } = await queryResources({
      subject: subjectId,
      count: -1,
      pageSize: 100
    }).catch(() => ({ resources: [] as AgResource[] }));

    const presented = resources.map(presentResource);

    // Group by fansub so the subscribe dialog can offer a concrete choice —
    // picking one fansub is what makes episode numbering consistent.
    const groups = new Map<string, PresentedResource[]>();
    for (const resource of presented) {
      const key = resource.fansub ?? resource.publisher ?? 'Unknown';
      const bucket = groups.get(key);
      if (bucket) bucket.push(resource);
      else groups.set(key, [resource]);
    }

    const episodes = mainEpisodes(subject);
    const year = subjectYear(subject);
    const title = displayTitle(subject);

    return c.json({
      subject: {
        id: subject.id,
        title,
        name: subject.name,
        nameCn: subject.name_cn,
        summary: subject.summary,
        date: subject.date,
        year,
        platform: subject.platform,
        eps: subject.eps ?? episodes.length,
        score: subject.rating?.score,
        rank: subject.rank,
        image: subject.images?.large ?? subject.images?.common,
        tags: (subject.tags ?? []).slice(0, 12).map((t) => t.name)
      },
      episodes: episodes.map((e) => ({
        ep: e.ep,
        sort: e.sort,
        title: e.name_cn?.trim() || e.name,
        name: e.name,
        airdate: e.airdate,
        desc: e.desc
      })),
      fansubs: [...groups.entries()]
        .map(([name, items]) => ({
          name,
          count: items.length,
          latestEpisode: items.reduce<number | undefined>(
            (max, r) =>
              r.parsed.episode !== undefined && (max === undefined || r.parsed.episode > max)
                ? r.parsed.episode
                : max,
            undefined
          ),
          resources: items
        }))
        .sort((a, b) => b.count - a.count),
      subscription: subscriptions.findBySubject(subjectId) ?? null,
      // What the subscribe dialog should prefill.
      suggested: {
        title,
        libraryFolder: seriesFolderName(title, year),
        season: 1
      }
    });
  })

  /** Upstream detail page: description, file list, alternate magnets. */
  .get('/detail/:provider/:providerId', async (c) => {
    const detail = await resourceDetail(c.req.param('provider'), c.req.param('providerId'));
    return c.json(detail);
  });
