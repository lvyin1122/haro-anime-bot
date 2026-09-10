import { config } from '../config.ts';
import { get, run, parseJson } from '../db/index.ts';

export interface BangumiImages {
  large?: string;
  common?: string;
  medium?: string;
  small?: string;
  grid?: string;
}

export interface BangumiEpisode {
  id: number;
  /** Episode number within its type. Only `type === 0` maps to SxxExx. */
  ep: number;
  sort: number;
  /** 0 = main episode, 1 = SP, 2 = OP, 3 = ED, ... */
  type: number;
  name: string;
  name_cn: string;
  airdate: string;
  desc?: string;
  duration?: string;
  duration_seconds?: number;
}

export interface BangumiSubject {
  id: number;
  name: string;
  name_cn: string;
  summary: string;
  date?: string;
  platform?: string;
  eps?: number;
  images?: BangumiImages;
  rating?: { score: number; total: number };
  rank?: number;
  tags?: Array<{ name: string; count: number }>;
  infobox?: Array<{ key: string; value: unknown }>;
}

export interface CachedSubject extends BangumiSubject {
  episodes: BangumiEpisode[];
  fetchedAt: number;
}

export interface CalendarDay {
  weekday: { en: string; cn: string; ja: string; id: number };
  items: Array<{
    id: number;
    name: string;
    name_cn: string;
    air_date?: string;
    images?: BangumiImages;
    rating?: { score: number; total: number };
  }>;
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// bgm.tv is a community service; serialize requests with a small gap rather
// than firing a burst when a page loads several subjects at once.
const MIN_REQUEST_GAP_MS = 250;
let chain: Promise<unknown> = Promise.resolve();

function throttle<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task, task);
  chain = result.then(
    () => new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS)),
    () => new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS))
  );
  return result;
}

async function bgm<T>(path: string, init: RequestInit = {}): Promise<T> {
  return throttle(async () => {
    const response = await fetch(`${config.BANGUMI_API}/${path.replace(/^\/+/, '')}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'User-Agent': config.BANGUMI_USER_AGENT,
        ...(init.headers as Record<string, string> | undefined)
      },
      signal: init.signal ?? AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      throw new Error(`Bangumi ${path} failed: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  });
}

export async function searchSubjects(keyword: string, limit = 20): Promise<BangumiSubject[]> {
  const result = await bgm<{ data: BangumiSubject[] | null }>(
    `v0/search/subjects?limit=${limit}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // type 2 = anime
      body: JSON.stringify({ keyword, filter: { type: [2] } })
    }
  );
  return result.data ?? [];
}

export async function getCalendar(): Promise<CalendarDay[]> {
  return bgm<CalendarDay[]>('calendar');
}

async function fetchEpisodes(subjectId: number): Promise<BangumiEpisode[]> {
  const episodes: BangumiEpisode[] = [];
  let offset = 0;

  // A long-running show can exceed the 100-per-page cap.
  for (;;) {
    const page = await bgm<{ total: number; data: BangumiEpisode[] }>(
      `v0/episodes?subject_id=${subjectId}&limit=100&offset=${offset}`
    );
    episodes.push(...page.data);
    offset += page.data.length;
    if (page.data.length === 0 || episodes.length >= page.total) break;
  }

  return episodes;
}

function readCache(subjectId: number): CachedSubject | undefined {
  const row = get<Record<string, unknown>>('SELECT * FROM subjects WHERE id = ?', subjectId);
  if (!row) return undefined;

  return {
    id: Number(row.id),
    name: String(row.name ?? ''),
    name_cn: String(row.name_cn ?? ''),
    summary: String(row.summary ?? ''),
    date: (row.air_date as string) ?? undefined,
    platform: (row.platform as string) ?? undefined,
    eps: row.eps == null ? undefined : Number(row.eps),
    rank: row.rank == null ? undefined : Number(row.rank),
    rating: row.score == null ? undefined : { score: Number(row.score), total: 0 },
    images: parseJson(row.images, {} as BangumiImages),
    tags: parseJson(row.tags, [] as Array<{ name: string; count: number }>),
    infobox: parseJson(row.infobox, [] as Array<{ key: string; value: unknown }>),
    episodes: parseJson(row.episodes, [] as BangumiEpisode[]),
    fetchedAt: Number(row.fetched_at ?? 0)
  };
}

function writeCache(subject: BangumiSubject, episodes: BangumiEpisode[]): void {
  run(
    `INSERT INTO subjects
       (id, name, name_cn, summary, air_date, eps, score, rank, platform, tags, images, infobox, episodes, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, name_cn = excluded.name_cn, summary = excluded.summary,
       air_date = excluded.air_date, eps = excluded.eps, score = excluded.score,
       rank = excluded.rank, platform = excluded.platform, tags = excluded.tags,
       images = excluded.images, infobox = excluded.infobox, episodes = excluded.episodes,
       fetched_at = excluded.fetched_at`,
    subject.id,
    subject.name,
    subject.name_cn ?? '',
    subject.summary ?? '',
    subject.date ?? null,
    subject.eps ?? null,
    subject.rating?.score ?? null,
    subject.rank ?? null,
    subject.platform ?? null,
    JSON.stringify(subject.tags ?? []),
    JSON.stringify(subject.images ?? {}),
    JSON.stringify(subject.infobox ?? []),
    JSON.stringify(episodes),
    Date.now()
  );
}

/**
 * Subject plus its full episode list, cached in SQLite for 12h. Pass
 * `force` after a show adds episodes mid-season.
 */
export async function getSubject(subjectId: number, force = false): Promise<CachedSubject> {
  const cached = readCache(subjectId);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const subject = await bgm<BangumiSubject>(`v0/subjects/${subjectId}`);
    const episodes = await fetchEpisodes(subjectId);
    writeCache(subject, episodes);
    return { ...subject, episodes, fetchedAt: Date.now() };
  } catch (error) {
    // Stale data beats a broken page when bgm.tv is unreachable.
    if (cached) return cached;
    throw error;
  }
}

/** Main-story episodes only, in broadcast order. */
/**
 * Cover art for a subject we have already cached, or undefined.
 *
 * Deliberately cache-only and never a fetch: this is called once per row when
 * listing subscriptions, and a list endpoint that fans out to bgm.tv would be
 * both slow and rude to a community-run service. A subscription with no cached
 * subject yet simply shows no art until something visits its detail page.
 */
export function cachedPoster(subjectId: number): string | undefined {
  const images = readCache(subjectId)?.images;
  return images?.common ?? images?.large ?? images?.medium;
}

export function mainEpisodes(subject: CachedSubject): BangumiEpisode[] {
  return subject.episodes.filter((e) => e.type === 0).sort((a, b) => a.sort - b.sort);
}

/** Pull a named field out of the Bangumi infobox (e.g. "动画制作"). */
export function infoboxValue(subject: BangumiSubject, key: string): string | undefined {
  const entry = subject.infobox?.find((i) => i.key === key);
  if (!entry) return undefined;
  if (typeof entry.value === 'string') return entry.value;
  if (Array.isArray(entry.value)) {
    return entry.value
      .map((v) => (typeof v === 'object' && v && 'v' in v ? String((v as { v: unknown }).v) : String(v)))
      .join(', ');
  }
  return undefined;
}

export function subjectYear(subject: { date?: string }): number | undefined {
  const year = Number(subject.date?.slice(0, 4));
  return Number.isFinite(year) && year > 1900 ? year : undefined;
}

export function displayTitle(subject: { name: string; name_cn?: string }): string {
  return subject.name_cn?.trim() || subject.name;
}
