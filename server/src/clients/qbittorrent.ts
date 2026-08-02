import { config } from '../config.ts';
import { log } from '../log.ts';

export interface QbTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  save_path: string;
  content_path: string;
  completion_on: number;
  category: string;
  tags: string;
  dlspeed: number;
  eta: number;
  num_seeds: number;
  num_leechs: number;
}

export interface QbFile {
  index: number;
  name: string;
  size: number;
  progress: number;
}

export interface AddTorrentOptions {
  magnet: string;
  savepath?: string;
  category?: string;
  tags?: string[];
  paused?: boolean;
}

export class QbittorrentError extends Error {
  // Written as an explicit field rather than a constructor parameter property:
  // Node's --experimental-strip-types (used by `pnpm dev`) cannot compile
  // parameter properties, only erase types.
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'QbittorrentError';
    this.status = status;
  }
}

/** Cached SID cookie. qBittorrent sessions are long-lived but not permanent. */
let sid: string | undefined;
let loginInFlight: Promise<string> | undefined;

function apiUrl(path: string): string {
  return `${config.QBITTORRENT_URL}/api/v2/${path.replace(/^\/+/, '')}`;
}

/**
 * qBittorrent rejects requests whose Origin/Referer do not match its own host
 * as cross-site forgery attempts. Sending Referer explicitly is what keeps
 * every call from coming back 403 when we talk to it from another container.
 */
function baseHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Referer: config.QBITTORRENT_URL };
  if (sid) headers.Cookie = `SID=${sid}`;
  return headers;
}

async function login(): Promise<string> {
  if (loginInFlight) return loginInFlight;

  loginInFlight = (async () => {
    const body = new URLSearchParams({
      username: config.QBITTORRENT_USERNAME,
      password: config.QBITTORRENT_PASSWORD
    });

    const response = await fetch(apiUrl('auth/login'), {
      method: 'POST',
      headers: {
        Referer: config.QBITTORRENT_URL,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(15_000)
    });

    const text = (await response.text()).trim();

    if (!response.ok) {
      throw new QbittorrentError(`login failed: HTTP ${response.status}`, response.status);
    }
    // qBittorrent answers 200 with the body "Fails." on bad credentials.
    if (text !== 'Ok.') {
      throw new QbittorrentError(
        text.toLowerCase().startsWith('fail')
          ? 'login failed: wrong username or password'
          : `login failed: unexpected response "${text}"`
      );
    }

    const cookie = response.headers.getSetCookie?.() ?? [];
    const match = cookie.map((c) => /SID=([^;]+)/.exec(c)).find(Boolean);
    if (!match?.[1]) {
      throw new QbittorrentError('login succeeded but no SID cookie was returned');
    }

    sid = match[1];
    return sid;
  })().finally(() => {
    loginInFlight = undefined;
  });

  return loginInFlight;
}

/**
 * Perform a request, logging in first if needed and retrying once on 403 —
 * which is how an expired session presents.
 */
async function request(
  path: string,
  init: RequestInit & { retryOnAuth?: boolean } = {}
): Promise<Response> {
  const { retryOnAuth = true, ...rest } = init;

  if (!sid) await login();

  const response = await fetch(apiUrl(path), {
    ...rest,
    headers: { ...baseHeaders(), ...(rest.headers as Record<string, string> | undefined) },
    signal: rest.signal ?? AbortSignal.timeout(30_000)
  });

  if (response.status === 403 && retryOnAuth) {
    sid = undefined;
    await login();
    return request(path, { ...init, retryOnAuth: false });
  }

  if (!response.ok) {
    throw new QbittorrentError(
      `${path} failed: HTTP ${response.status} ${await response.text().catch(() => '')}`.trim(),
      response.status
    );
  }

  return response;
}

export async function version(): Promise<string> {
  return (await request('app/version')).text();
}

export async function listTorrents(params: {
  hashes?: string[];
  category?: string;
  tag?: string;
} = {}): Promise<QbTorrent[]> {
  const search = new URLSearchParams();
  if (params.hashes?.length) search.set('hashes', params.hashes.join('|'));
  if (params.category) search.set('category', params.category);
  if (params.tag) search.set('tag', params.tag);

  const query = search.toString();
  const response = await request(`torrents/info${query ? `?${query}` : ''}`);
  return (await response.json()) as QbTorrent[];
}

export async function listFiles(hash: string): Promise<QbFile[]> {
  const response = await request(`torrents/files?hash=${encodeURIComponent(hash)}`);
  return (await response.json()) as QbFile[];
}

export async function ensureCategory(name: string, savePath?: string): Promise<void> {
  const body = new URLSearchParams({ category: name });
  if (savePath) body.set('savePath', savePath);
  try {
    await request('torrents/createCategory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
  } catch (error) {
    // Already-exists comes back as a 409; anything else is worth surfacing.
    if (error instanceof QbittorrentError && error.status === 409) return;
    log.warn('qbittorrent', `could not create category "${name}"`, {
      error: (error as Error).message
    });
  }
}

export async function addTorrent(options: AddTorrentOptions): Promise<void> {
  const form = new FormData();
  form.set('urls', options.magnet);
  if (options.savepath) form.set('savepath', options.savepath);
  if (options.category) form.set('category', options.category);
  if (options.tags?.length) form.set('tags', options.tags.join(','));
  // "Original" keeps the release's own folder structure, which is what the
  // importer's per-file episode parsing expects for batch torrents.
  form.set('contentLayout', 'Original');
  form.set('paused', options.paused ? 'true' : 'false');

  const response = await request('torrents/add', { method: 'POST', body: form });
  const text = (await response.text()).trim();

  // A 200 with "Fails." means the magnet was rejected (malformed, or a
  // torrent qBittorrent refuses); it does not throw on its own.
  if (text.toLowerCase().startsWith('fail')) {
    throw new QbittorrentError(`torrents/add rejected the magnet: ${text}`);
  }
}

export async function deleteTorrent(hash: string, deleteFiles: boolean): Promise<void> {
  await request('torrents/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) })
  });
}

/**
 * qBittorrent 4.x reports a finished torrent as `pausedUP` and 5.x as
 * `stoppedUP`, with `uploading` / `stalledUP` / `queuedUP` / `forcedUP` all
 * also meaning "done". Matching on state strings across versions is a losing
 * game, so completion is judged on progress and the completion timestamp.
 */
export function isComplete(torrent: QbTorrent): boolean {
  return torrent.progress >= 1 && torrent.completion_on > 0;
}

/** Reset cached auth. Exposed so the settings page can force a fresh login. */
export function resetSession(): void {
  sid = undefined;
}
