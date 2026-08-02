/** Typed wrappers over the Haro API. */

export interface ParsedInfo {
  episode?: number;
  episodeTo?: number;
  season?: number;
  resolution?: string;
  subtitleLanguages?: string[];
  source?: string;
  lowConfidence: boolean;
}

export interface Resource {
  id: number;
  provider: string;
  providerId: string;
  title: string;
  href: string;
  type: string;
  magnet: string;
  tracker?: string;
  infoHash?: string;
  size: number;
  fansub?: string;
  publisher?: string;
  subjectId?: number;
  createdAt: string;
  parsed: ParsedInfo;
}

export interface FansubGroup {
  name: string;
  count: number;
  latestEpisode?: number;
  resources: Resource[];
}

export interface SubjectDetail {
  id: number;
  title: string;
  name: string;
  nameCn: string;
  summary: string;
  date?: string;
  year?: number;
  platform?: string;
  eps: number;
  score?: number;
  rank?: number;
  image?: string;
  tags: string[];
}

export interface BangumiEpisodeInfo {
  ep: number;
  sort: number;
  title: string;
  name: string;
  airdate: string;
  desc?: string;
}

export interface SubscriptionFilter {
  fansubs?: string[];
  include?: string[];
  keywords?: string[];
  exclude?: string[];
  types?: string[];
  search?: string[];
}

export interface Subscription {
  id: number;
  subjectId: number;
  title: string;
  season: number;
  episodeOffset: number;
  filter: SubscriptionFilter;
  libraryFolder: string;
  enabled: boolean;
  autoDownload: boolean;
  lastCheckedAt?: number;
  cursorAt?: number;
  createdAt: number;
  stats?: {
    total: number;
    imported: number;
    active: number;
    failed: number;
    latestEpisode?: number;
  };
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'importing'
  | 'imported'
  | 'failed'
  | 'skipped';

export interface Download {
  id: number;
  subscriptionId?: number;
  title: string;
  infoHash: string;
  size?: number;
  fansub?: string;
  season?: number;
  episode?: number;
  episodeTo?: number;
  status: DownloadStatus;
  needsReview: boolean;
  qbState?: string;
  qbProgress: number;
  contentPath?: string;
  error?: string;
  addedAt: number;
  completedAt?: number;
  importedAt?: number;
}

export interface AnimeDetail {
  subject: SubjectDetail;
  episodes: BangumiEpisodeInfo[];
  fansubs: FansubGroup[];
  subscription: Subscription | null;
  suggested: { title: string; libraryFolder: string; season: number };
}

export interface EpisodeSlot {
  ep: number;
  title: string;
  airdate?: string;
  aired: boolean;
  status: DownloadStatus | 'missing';
  downloadId?: number;
  progress: number;
  needsReview: boolean;
}

export interface ServiceStatus {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HardlinkProbe {
  ok: boolean;
  downloadRootExists: boolean;
  libraryRootExists: boolean;
  sameDevice: boolean;
  writable: boolean;
  detail: string;
}

export interface Health {
  status: 'ok' | 'degraded';
  services: ServiceStatus[];
  paths: {
    downloadRoot: string;
    libraryRoot: string;
    qbDownloadRoot: string;
    dataDir: string;
    hardlink: HardlinkProbe;
  };
  warnings: string[];
}

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
  state: ReadyState;
  itemId?: string;
  played: boolean;
  playedPercentage?: number;
}

export interface ReadyResponse {
  items: ReadyItem[];
  /** Configured browser-facing Jellyfin base, or null to derive one. */
  publicUrl: string | null;
  serverId: string | null;
  jellyfinConfigured: boolean;
  error: string | null;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers
    }
  });

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? typeof body.error === 'string'
          ? body.error
          : JSON.stringify(body.error)
        : `Request failed (HTTP ${response.status})`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export const api = {
  // Health returns 503 when degraded, which is information rather than a
  // failure — read the body either way.
  async health(): Promise<Health> {
    const response = await fetch('/api/health');
    return (await response.json()) as Health;
  },

  searchSubjects: (q: string) =>
    request<{
      subjects: Array<{
        id: number;
        title: string;
        name: string;
        nameCn: string;
        year?: number;
        date?: string;
        image?: string;
        score?: number;
        summary?: string;
        subscribed: boolean;
      }>;
    }>(`/discover/subjects?q=${encodeURIComponent(q)}`),

  searchResources: (params: { q?: string; fansub?: string; page?: number }) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.fansub) search.set('fansub', params.fansub);
    search.set('page', String(params.page ?? 1));
    return request<{ resources: Resource[]; page: number; complete: boolean }>(
      `/discover/resources?${search}`
    );
  },

  calendar: () =>
    request<{
      days: Array<{
        weekday: { en: string; cn: string; id: number };
        items: Array<{
          id: number;
          title: string;
          name: string;
          image?: string;
          score?: number;
          subscribed: boolean;
        }>;
      }>;
    }>('/discover/calendar'),

  anime: (subjectId: number) => request<AnimeDetail>(`/discover/anime/${subjectId}`),

  subscriptions: () => request<{ subscriptions: Subscription[] }>('/subscriptions'),

  subscription: (id: number) =>
    request<{ subscription: Subscription; downloads: Download[] }>(`/subscriptions/${id}`),

  subscriptionEpisodes: (id: number) =>
    request<{ episodes: EpisodeSlot[]; extra: EpisodeSlot[] }>(`/subscriptions/${id}/episodes`),

  previewFilter: (body: {
    subjectId: number;
    filter: SubscriptionFilter;
    episodeOffset?: number;
  }) =>
    request<{
      total: number;
      shown: number;
      unparsed: number;
      episodes: number[];
      matches: Array<{
        title: string;
        fansub?: string;
        size: number;
        createdAt: string;
        episode?: number;
        resolution?: string;
        subtitleLanguages?: string[];
        lowConfidence: boolean;
      }>;
    }>('/subscriptions/preview', { method: 'POST', body: JSON.stringify(body) }),

  createSubscription: (body: Record<string, unknown>) =>
    request<{ subscription: Subscription }>('/subscriptions', {
      method: 'POST',
      body: JSON.stringify(body)
    }),

  updateSubscription: (id: number, body: Record<string, unknown>) =>
    request<{ subscription: Subscription }>(`/subscriptions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body)
    }),

  deleteSubscription: (id: number) =>
    request<{ ok: true }>(`/subscriptions/${id}`, { method: 'DELETE' }),

  scanSubscription: (id: number, backfill = false) =>
    request<{ result: { found: number; queued: number; skipped: number; errors: string[] } }>(
      `/subscriptions/${id}/scan?backfill=${backfill}`,
      { method: 'POST' }
    ),

  downloads: (params: { status?: DownloadStatus[]; subscriptionId?: number } = {}) => {
    const search = new URLSearchParams();
    for (const status of params.status ?? []) search.append('status', status);
    if (params.subscriptionId) search.set('subscriptionId', String(params.subscriptionId));
    return request<{ downloads: Download[] }>(`/downloads?${search}`);
  },

  addDownload: (body: Record<string, unknown>) =>
    request<{ download: Download; alreadyQueued?: boolean }>('/downloads', {
      method: 'POST',
      body: JSON.stringify(body)
    }),

  retryDownload: (id: number) =>
    request<{ download: Download }>(`/downloads/${id}/retry`, { method: 'POST' }),

  reimportDownload: (id: number) =>
    request<{ download: Download }>(`/downloads/${id}/import`, { method: 'POST' }),

  deleteDownload: (id: number, options: { removeTorrent?: boolean; deleteFiles?: boolean } = {}) =>
    request<{ ok: true }>(
      `/downloads/${id}?removeTorrent=${options.removeTorrent ?? false}&deleteFiles=${options.deleteFiles ?? false}`,
      { method: 'DELETE' }
    ),

  refreshDownloads: () => request<{ downloads: Download[] }>('/downloads/refresh', { method: 'POST' }),

  ready: (limit = 40) => request<ReadyResponse>(`/library/ready?limit=${limit}`),

  readyEpisode: (downloadId: number) =>
    request<{
      item: ReadyItem | null;
      publicUrl: string | null;
      serverId: string | null;
      error: string | null;
    }>(`/library/episode/${downloadId}`),

  rescanLibrary: () =>
    request<{ ok: boolean; detail: string }>('/library/rescan', { method: 'POST' }),

  settings: () =>
    request<{ config: Record<string, unknown>; warnings: string[] }>('/settings'),

  testQbittorrent: () =>
    request<{ ok: boolean; detail: string }>('/settings/test/qbittorrent', { method: 'POST' }),

  testJellyfin: () =>
    request<{ ok: boolean; detail: string; libraries?: unknown[] }>('/settings/test/jellyfin', {
      method: 'POST'
    }),

  refreshJellyfin: () =>
    request<{ ok: boolean; detail: string }>('/settings/jellyfin/refresh', { method: 'POST' }),

  scanAll: () => request<{ results: unknown[] }>('/settings/scan', { method: 'POST' }),

  events: () =>
    request<{
      events: Array<{
        id: number;
        level: string;
        scope: string;
        message: string;
        createdAt: number;
      }>;
    }>('/settings/events')
};

// --- formatting helpers ----------------------------------------------------

/** AnimeGarden reports sizes in KB. */
export function formatSize(kb?: number): string {
  if (!kb || kb <= 0) return '—';
  if (kb < 1024) return `${Math.round(kb)} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRelative(value: string | number): string {
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  const seconds = Math.round((Date.now() - time) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(time).toLocaleDateString();
}

export function formatEpisode(episode?: number): string {
  if (episode === undefined) return '—';
  return Number.isInteger(episode) ? `E${String(episode).padStart(2, '0')}` : `E${episode}`;
}

/**
 * Base URL for Jellyfin links, from the *browser's* point of view.
 *
 * The server's JELLYFIN_URL is usually host.docker.internal, which no browser
 * can resolve, so a configured JELLYFIN_PUBLIC_URL wins. Failing that, assume
 * Jellyfin sits on the same host Haro was loaded from — true for the standard
 * single-Pi setup, and overridable in .env when it is not.
 */
export function jellyfinBase(publicUrl: string | null): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, '');
  return `${window.location.protocol}//${window.location.hostname}:8096`;
}

/** Deep link to an item's page in the Jellyfin web client. */
export function jellyfinItemUrl(
  publicUrl: string | null,
  itemId: string,
  serverId: string | null
): string {
  const query = new URLSearchParams({ id: itemId });
  if (serverId) query.set('serverId', serverId);
  return `${jellyfinBase(publicUrl)}/web/index.html#/details?${query}`;
}
