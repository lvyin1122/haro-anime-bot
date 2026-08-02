import { fetchResources, type Resource, type FilterOptions } from '@animegarden/client';

import { config } from '../config.ts';

/** Resources always carry tracker + metadata, so callers never re-query. */
export type AgResource = Resource<{ tracker: true }>;

export interface ActiveSubject {
  id: number;
  name: string;
  keywords: string[];
  activedAt: string;
  isArchived: boolean;
}

/**
 * The subscription filter as stored in `subscriptions.filter_json`. Field names
 * mirror `FilterOptions` from @animegarden/client so this drops straight into
 * fetchResources without a translation layer.
 */
export interface SubscriptionFilter {
  fansubs?: string[];
  include?: string[];
  keywords?: string[];
  exclude?: string[];
  types?: string[];
  search?: string[];
}

const baseOptions = () => ({
  baseURL: `${config.ANIMEGARDEN_API}/`,
  retry: 2,
  timeout: 30_000
});

/** Strip empty arrays — an empty `include: []` is not the same as omitting it. */
function cleanFilter(filter: SubscriptionFilter): FilterOptions {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value) && value.length > 0) out[key] = value;
  }
  return out as FilterOptions;
}

export interface QueryOptions extends SubscriptionFilter {
  subject?: number;
  page?: number;
  pageSize?: number;
  after?: Date;
  before?: Date;
  /** -1 fetches every match across pages; omit for a single page. */
  count?: number;
}

export async function queryResources(options: QueryOptions): Promise<{
  resources: AgResource[];
  complete: boolean;
}> {
  const { subject, page, pageSize, after, before, count, ...filter } = options;

  const result = await fetchResources({
    ...baseOptions(),
    ...cleanFilter(filter),
    ...(subject ? { subject } : {}),
    ...(after ? { after } : {}),
    ...(before ? { before } : {}),
    ...(count !== undefined ? { count } : {}),
    page: page ?? 1,
    pageSize: pageSize ?? 40,
    tracker: true
  });

  if (!result.ok && result.resources.length === 0) {
    throw new Error(
      `AnimeGarden query failed: ${result.error instanceof Error ? result.error.message : String(result.error ?? 'unknown error')}`
    );
  }

  return {
    resources: result.resources as AgResource[],
    complete: result.pagination?.complete ?? true
  };
}

/** Subjects AnimeGarden currently tracks — the "airing now" list. */
export async function activeSubjects(): Promise<ActiveSubject[]> {
  const response = await fetch(`${config.ANIMEGARDEN_API}/subjects`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`/subjects failed: HTTP ${response.status}`);
  const body = (await response.json()) as { subjects: ActiveSubject[] };
  return body.subjects ?? [];
}

export async function resourceDetail(
  provider: string,
  providerId: string
): Promise<{
  description?: string;
  files?: Array<{ name: string; size: string }>;
  magnets?: Array<{ name: string; url: string }>;
}> {
  const response = await fetch(
    `${config.ANIMEGARDEN_API}/detail/${encodeURIComponent(provider)}/${encodeURIComponent(providerId)}`,
    { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }
  );
  if (!response.ok) throw new Error(`/detail failed: HTTP ${response.status}`);
  return (await response.json()) as Awaited<ReturnType<typeof resourceDetail>>;
}

export async function ping(): Promise<boolean> {
  const response = await fetch(`${config.ANIMEGARDEN_API}/resources?pageSize=1`, {
    signal: AbortSignal.timeout(15_000)
  });
  return response.ok;
}

/**
 * Resource types that never contain episodes worth filing into a TV library.
 * Soundtracks in particular sit under the same Bangumi subject as the show and
 * carry release dates that read convincingly as episode numbers.
 *
 * A denylist rather than an allowlist: an unfamiliar new type should surface
 * for review, not be silently dropped.
 */
const NON_EPISODE_TYPES = new Set(['音乐', '音樂', '漫画', '漫畫', '游戏', '遊戲', '其他']);

export function isEpisodeType(type: string | undefined): boolean {
  return !type || !NON_EPISODE_TYPES.has(type.trim());
}

/** AnimeGarden reports sizes in KB. */
export function formatSize(kb: number | undefined): string {
  if (!kb || kb <= 0) return '—';
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}
