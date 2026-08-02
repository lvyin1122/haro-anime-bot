import { config } from '../config.ts';
import { log } from '../log.ts';

export interface VirtualFolder {
  Name: string;
  CollectionType?: string;
  Locations: string[];
  ItemId: string;
  LibraryOptions?: {
    MetadataSavers?: string[];
    DisabledLocalMetadataReaders?: string[];
    TypeOptions?: Array<{
      Type: string;
      MetadataFetchers?: string[];
      MetadataFetcherOrder?: string[];
    }>;
  };
}

export interface JellyfinItem {
  Id: string;
  Name: string;
  Type: string;
  Path?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  SeriesId?: string;
  RunTimeTicks?: number;
  UserData?: {
    Played?: boolean;
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
  };
}

export interface PlayableEpisode {
  itemId: string;
  seriesId?: string;
  serverId?: string;
  name: string;
  played: boolean;
  playedPercentage?: number;
  /** Episode page in the Jellyfin web client, with its Play button. */
  url: string;
}

export class JellyfinError extends Error {}

function jellyfinUrl(path: string): string {
  return `${config.JELLYFIN_URL}/${path.replace(/^\/+/, '')}`;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.JELLYFIN_API_KEY) {
    throw new JellyfinError('JELLYFIN_API_KEY is not configured');
  }

  const response = await fetch(jellyfinUrl(path), {
    ...init,
    headers: {
      Accept: 'application/json',
      'X-Emby-Token': config.JELLYFIN_API_KEY,
      ...(init.headers as Record<string, string> | undefined)
    },
    signal: init.signal ?? AbortSignal.timeout(30_000)
  });

  if (!response.ok) {
    throw new JellyfinError(`${path} failed: HTTP ${response.status}`);
  }
  return response;
}

/** Unauthenticated — used by the health check to tell "down" from "bad key". */
export async function publicInfo(): Promise<{ ServerName: string; Version: string; Id: string }> {
  const response = await fetch(jellyfinUrl('System/Info/Public'), {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new JellyfinError(`System/Info/Public: HTTP ${response.status}`);
  return (await response.json()) as { ServerName: string; Version: string; Id: string };
}

/**
 * Jellyfin moved item queries from /Users/{id}/Items to /Items?userId= in
 * 10.9. Try the current form and fall back, so this works across versions.
 */
async function queryItems(params: URLSearchParams): Promise<{ Items: JellyfinItem[] }> {
  params.set('userId', config.JELLYFIN_USER_ID);
  try {
    const response = await request(`Items?${params}`);
    return (await response.json()) as { Items: JellyfinItem[] };
  } catch (error) {
    if (!(error instanceof JellyfinError) || !error.message.includes('404')) throw error;
    params.delete('userId');
    const response = await request(`Users/${config.JELLYFIN_USER_ID}/Items?${params}`);
    return (await response.json()) as { Items: JellyfinItem[] };
  }
}

export async function getVirtualFolders(): Promise<VirtualFolder[]> {
  const response = await request('Library/VirtualFolders');
  return (await response.json()) as VirtualFolder[];
}

async function triggerRefresh(): Promise<void> {
  await request('Library/Refresh', { method: 'POST' });
}

let pending: ReturnType<typeof setTimeout> | undefined;

/**
 * Importing a batch torrent can produce a dozen episodes in a few seconds.
 * Debounce so that turns into one library scan instead of a dozen — a full
 * scan is not free on a Pi.
 */
export function scheduleLibraryRefresh(delayMs = 30_000): void {
  if (!config.JELLYFIN_API_KEY) return;
  if (pending) clearTimeout(pending);

  pending = setTimeout(() => {
    pending = undefined;
    triggerRefresh()
      .then(() => log.info('jellyfin', 'library refresh triggered'))
      .catch((error: unknown) =>
        log.warn('jellyfin', 'library refresh failed', { error: (error as Error).message })
      );
  }, delayMs);

  // Never hold the process open just to run a refresh.
  pending.unref?.();
}

/** Force an immediate refresh, for the "Rescan now" button. */
export async function refreshNow(): Promise<void> {
  if (pending) {
    clearTimeout(pending);
    pending = undefined;
  }
  await triggerRefresh();
}

// --- finding what we imported, so it can be played -------------------------

let cachedServerId: string | undefined;

export async function serverId(): Promise<string | undefined> {
  if (cachedServerId) return cachedServerId;
  try {
    cachedServerId = (await publicInfo()).Id;
  } catch {
    // Not fatal: the deep link still resolves without a serverId.
  }
  return cachedServerId;
}

/**
 * Build a browser-facing link to an item's page in the Jellyfin web client.
 *
 * `base` must be an address the *viewer's browser* can reach — not
 * JELLYFIN_URL, which is this container's route to the server.
 */
export function itemUrl(base: string, itemId: string, server?: string): string {
  const root = base.replace(/\/+$/, '');
  const query = new URLSearchParams({ id: itemId });
  if (server) query.set('serverId', server);
  // Jellyfin 10.9+ web routing. The details page is the reliable target — it
  // opens on the episode with its Play button, and unlike a direct #/video
  // link it degrades gracefully if the item needs a resume prompt.
  return `${root}/web/index.html#/details?${query}`;
}

/**
 * Series lookups are the expensive part of resolving playability, and the
 * dashboard polls. A short TTL absorbs that; imports and manual rescans clear
 * it so a newly indexed series shows up immediately rather than in five
 * minutes.
 */
const SERIES_TTL_MS = 5 * 60_000;
const seriesCache = new Map<string, { item?: JellyfinItem; at: number }>();

export function invalidateSeriesCache(): void {
  seriesCache.clear();
}

/**
 * Locate the Jellyfin series matching a library folder.
 *
 * Matching on `Path` is exact and survives Jellyfin renaming the series from
 * NFO metadata; the title search is only how we get a candidate set.
 */
export async function findSeries(
  libraryFolderPath: string,
  title: string
): Promise<JellyfinItem | undefined> {
  const cached = seriesCache.get(libraryFolderPath);
  if (cached && Date.now() - cached.at < SERIES_TTL_MS) return cached.item;

  const found = await findSeriesUncached(libraryFolderPath, title);
  seriesCache.set(libraryFolderPath, { item: found, at: Date.now() });
  return found;
}

async function findSeriesUncached(
  libraryFolderPath: string,
  title: string
): Promise<JellyfinItem | undefined> {
  const params = new URLSearchParams({
    recursive: 'true',
    includeItemTypes: 'Series',
    fields: 'Path',
    limit: '50'
  });

  // Search by title first; fall back to listing all series when the title has
  // been rewritten to something our search term no longer matches.
  for (const searchTerm of [title, undefined]) {
    const scoped = new URLSearchParams(params);
    if (searchTerm) scoped.set('searchTerm', searchTerm);
    else scoped.set('limit', '500');

    const { Items } = await queryItems(scoped);
    const byPath = Items.find((item) => item.Path === libraryFolderPath);
    if (byPath) return byPath;

    if (searchTerm) {
      const byName = Items.find((item) => item.Name === title);
      if (byName) return byName;
    }
  }

  return undefined;
}

/** Episodes of one season, keyed for matching against what we imported. */
export async function seasonEpisodes(
  seriesItemId: string,
  season: number
): Promise<JellyfinItem[]> {
  const params = new URLSearchParams({
    userId: config.JELLYFIN_USER_ID,
    season: String(season),
    fields: 'Path'
  });

  const response = await request(`Shows/${seriesItemId}/Episodes?${params}`);
  const body = (await response.json()) as { Items: JellyfinItem[] };
  return body.Items ?? [];
}

/**
 * Pick the Jellyfin episode corresponding to a file we hardlinked.
 * Path is authoritative; the episode number is the fallback for when Jellyfin
 * reports a path from a differently-mounted namespace.
 */
export function matchEpisode(
  episodes: JellyfinItem[],
  libraryPath: string | undefined,
  episodeNumber: number
): JellyfinItem | undefined {
  if (libraryPath) {
    const byPath = episodes.find((item) => item.Path === libraryPath);
    if (byPath) return byPath;

    // Same filename, different mount prefix.
    const fileName = libraryPath.slice(libraryPath.lastIndexOf('/') + 1);
    const byName = episodes.find((item) => item.Path?.endsWith(`/${fileName}`));
    if (byName) return byName;
  }

  return episodes.find((item) => item.IndexNumber === Math.floor(episodeNumber));
}

/**
 * Whether a library covering `path` is set up to read our NFO files. If online
 * providers outrank the local reader, Jellyfin will overwrite the Bangumi
 * titles we wrote, which looks like the importer misbehaving when it is not.
 */
export function describeNfoReadiness(
  folders: VirtualFolder[],
  libraryRoot: string
): { library?: string; nfoEnabled: boolean; onlineFetchers: string[] } {
  const match = folders.find((f) =>
    f.Locations?.some((loc) => libraryRoot === loc || libraryRoot.startsWith(`${loc}/`))
  );
  if (!match) return { nfoEnabled: false, onlineFetchers: [] };

  const disabled = match.LibraryOptions?.DisabledLocalMetadataReaders ?? [];
  const nfoEnabled = !disabled.some((d) => d.toLowerCase().includes('nfo'));

  const onlineFetchers = (match.LibraryOptions?.TypeOptions ?? [])
    .filter((t) => t.Type === 'Series')
    .flatMap((t) => t.MetadataFetchers ?? []);

  return { library: match.Name, nfoEnabled, onlineFetchers };
}
