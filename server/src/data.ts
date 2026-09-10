import type { SubscriptionFilter } from './clients/animegarden.ts';
import { all, get, parseJson, run } from './db/index.ts';

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'importing'
  | 'imported'
  | 'failed'
  | 'skipped';

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
}

export interface Download {
  id: number;
  subscriptionId?: number;
  resourceId?: number;
  provider?: string;
  providerId?: string;
  title: string;
  magnet: string;
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

type SubscriptionRow = Record<string, unknown>;
type DownloadRow = Record<string, unknown>;

const num = (v: unknown): number | undefined =>
  v === null || v === undefined ? undefined : Number(v);
const str = (v: unknown): string | undefined =>
  v === null || v === undefined || v === '' ? undefined : String(v);

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    id: Number(row.id),
    subjectId: Number(row.subject_id),
    title: String(row.title),
    season: Number(row.season),
    episodeOffset: Number(row.episode_offset),
    filter: parseJson<SubscriptionFilter>(row.filter_json, {}),
    libraryFolder: String(row.library_folder),
    enabled: Boolean(row.enabled),
    autoDownload: Boolean(row.auto_download),
    lastCheckedAt: num(row.last_checked_at),
    cursorAt: num(row.cursor_at),
    createdAt: Number(row.created_at)
  };
}

function toDownload(row: DownloadRow): Download {
  return {
    id: Number(row.id),
    subscriptionId: num(row.subscription_id),
    resourceId: num(row.resource_id),
    provider: str(row.provider),
    providerId: str(row.provider_id),
    title: String(row.title),
    magnet: String(row.magnet),
    infoHash: String(row.info_hash),
    size: num(row.size),
    fansub: str(row.fansub),
    season: num(row.season),
    episode: num(row.episode),
    episodeTo: num(row.episode_to),
    status: String(row.status) as DownloadStatus,
    needsReview: Boolean(row.needs_review),
    qbState: str(row.qb_state),
    qbProgress: Number(row.qb_progress ?? 0),
    contentPath: str(row.content_path),
    error: str(row.error),
    addedAt: Number(row.added_at),
    completedAt: num(row.completed_at),
    importedAt: num(row.imported_at)
  };
}

// --- subscriptions ---------------------------------------------------------

export const subscriptions = {
  list(): Subscription[] {
    return all<SubscriptionRow>('SELECT * FROM subscriptions ORDER BY created_at DESC').map(
      toSubscription
    );
  },

  listEnabled(): Subscription[] {
    return all<SubscriptionRow>(
      'SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY COALESCE(last_checked_at, 0) ASC'
    ).map(toSubscription);
  },

  find(id: number): Subscription | undefined {
    const row = get<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = ?', id);
    return row ? toSubscription(row) : undefined;
  },

  findBySubject(subjectId: number): Subscription | undefined {
    const row = get<SubscriptionRow>('SELECT * FROM subscriptions WHERE subject_id = ?', subjectId);
    return row ? toSubscription(row) : undefined;
  },

  create(input: {
    subjectId: number;
    title: string;
    season: number;
    episodeOffset: number;
    filter: SubscriptionFilter;
    libraryFolder: string;
    enabled: boolean;
    autoDownload: boolean;
    cursorAt?: number;
  }): Subscription {
    const result = run(
      `INSERT INTO subscriptions
         (subject_id, title, season, episode_offset, filter_json, library_folder,
          enabled, auto_download, cursor_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.subjectId,
      input.title,
      input.season,
      input.episodeOffset,
      JSON.stringify(input.filter),
      input.libraryFolder,
      input.enabled ? 1 : 0,
      input.autoDownload ? 1 : 0,
      input.cursorAt ?? null,
      Date.now()
    );
    return this.find(Number(result.lastInsertRowid))!;
  },

  update(id: number, patch: Partial<Omit<Subscription, 'id' | 'createdAt'>>): Subscription {
    const columns: Record<string, unknown> = {};
    if (patch.title !== undefined) columns.title = patch.title;
    if (patch.season !== undefined) columns.season = patch.season;
    if (patch.episodeOffset !== undefined) columns.episode_offset = patch.episodeOffset;
    if (patch.filter !== undefined) columns.filter_json = JSON.stringify(patch.filter);
    if (patch.libraryFolder !== undefined) columns.library_folder = patch.libraryFolder;
    if (patch.enabled !== undefined) columns.enabled = patch.enabled ? 1 : 0;
    if (patch.autoDownload !== undefined) columns.auto_download = patch.autoDownload ? 1 : 0;
    if (patch.lastCheckedAt !== undefined) columns.last_checked_at = patch.lastCheckedAt;
    if (patch.cursorAt !== undefined) columns.cursor_at = patch.cursorAt;

    const keys = Object.keys(columns);
    if (keys.length > 0) {
      run(
        `UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
        ...keys.map((k) => columns[k]),
        id
      );
    }
    return this.find(id)!;
  },

  remove(id: number): void {
    run('DELETE FROM subscriptions WHERE id = ?', id);
  }
};

// --- downloads -------------------------------------------------------------

export const downloads = {
  list(options: { subscriptionId?: number; status?: DownloadStatus[]; limit?: number } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];

    if (options.subscriptionId !== undefined) {
      where.push('subscription_id = ?');
      params.push(options.subscriptionId);
    }
    if (options.status?.length) {
      where.push(`status IN (${options.status.map(() => '?').join(', ')})`);
      params.push(...options.status);
    }

    const sql =
      `SELECT * FROM downloads` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY added_at DESC LIMIT ?`;

    return all<DownloadRow>(sql, ...params, options.limit ?? 200).map(toDownload);
  },

  find(id: number): Download | undefined {
    const row = get<DownloadRow>('SELECT * FROM downloads WHERE id = ?', id);
    return row ? toDownload(row) : undefined;
  },

  findByInfoHash(infoHash: string): Download | undefined {
    const row = get<DownloadRow>('SELECT * FROM downloads WHERE info_hash = ?', infoHash);
    return row ? toDownload(row) : undefined;
  },

  /** Downloads that qBittorrent still needs to be polled about. */
  active(): Download[] {
    return all<DownloadRow>(
      `SELECT * FROM downloads WHERE status IN ('queued', 'downloading', 'completed', 'importing')`
    ).map(toDownload);
  },

  /** Episode numbers already secured for a subscription, so we skip re-grabbing them. */
  claimedEpisodes(subscriptionId: number): Set<number> {
    const rows = all<{ episode: number }>(
      `SELECT DISTINCT episode FROM downloads
       WHERE subscription_id = ? AND episode IS NOT NULL
         AND status IN ('queued', 'downloading', 'completed', 'importing', 'imported')`,
      subscriptionId
    );
    return new Set(rows.map((r) => Number(r.episode)));
  },

  create(input: Omit<Download, 'id' | 'qbProgress' | 'needsReview'> & { needsReview?: boolean }) {
    const result = run(
      `INSERT INTO downloads
         (subscription_id, resource_id, provider, provider_id, title, magnet, info_hash,
          size, fansub, season, episode, episode_to, status, needs_review, added_at,
          content_path, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.subscriptionId ?? null,
      input.resourceId ?? null,
      input.provider ?? null,
      input.providerId ?? null,
      input.title,
      input.magnet,
      input.infoHash,
      input.size ?? null,
      input.fansub ?? null,
      input.season ?? null,
      input.episode ?? null,
      input.episodeTo ?? null,
      input.status,
      input.needsReview ? 1 : 0,
      input.addedAt,
      input.contentPath ?? null,
      input.completedAt ?? null
    );
    return this.find(Number(result.lastInsertRowid))!;
  },

  update(id: number, patch: Partial<Download>): void {
    const columns: Record<string, unknown> = {};
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.qbState !== undefined) columns.qb_state = patch.qbState;
    if (patch.qbProgress !== undefined) columns.qb_progress = patch.qbProgress;
    if (patch.contentPath !== undefined) columns.content_path = patch.contentPath;
    if (patch.error !== undefined) columns.error = patch.error;
    if (patch.episode !== undefined) columns.episode = patch.episode;
    if (patch.season !== undefined) columns.season = patch.season;
    if (patch.needsReview !== undefined) columns.needs_review = patch.needsReview ? 1 : 0;
    if (patch.completedAt !== undefined) columns.completed_at = patch.completedAt;
    if (patch.importedAt !== undefined) columns.imported_at = patch.importedAt;

    const keys = Object.keys(columns);
    if (keys.length === 0) return;

    run(
      `UPDATE downloads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
      ...keys.map((k) => columns[k]),
      id
    );
  },

  remove(id: number): void {
    run('DELETE FROM downloads WHERE id = ?', id);
  }
};

// --- imported files --------------------------------------------------------

export interface ImportedFile {
  id: number;
  downloadId: number;
  sourcePath: string;
  libraryPath: string;
  episode?: number;
  kind: 'video' | 'subtitle' | 'metadata' | 'artwork';
  createdAt: number;
}

function toImportedFile(row: Record<string, unknown>): ImportedFile {
  return {
    id: Number(row.id),
    downloadId: Number(row.download_id),
    sourcePath: String(row.source_path),
    libraryPath: String(row.library_path),
    episode: num(row.episode),
    kind: String(row.kind) as ImportedFile['kind'],
    createdAt: Number(row.created_at)
  };
}

export const importedFiles = {
  record(input: Omit<ImportedFile, 'id' | 'createdAt'>): void {
    run(
      `INSERT INTO imported_files (download_id, source_path, library_path, episode, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.downloadId,
      input.sourcePath,
      input.libraryPath,
      input.episode ?? null,
      input.kind,
      Date.now()
    );
  },

  forDownload(downloadId: number): ImportedFile[] {
    return all<Record<string, unknown>>(
      'SELECT * FROM imported_files WHERE download_id = ? ORDER BY id',
      downloadId
    ).map(toImportedFile);
  },

  find(id: number): ImportedFile | undefined {
    const row = get<Record<string, unknown>>('SELECT * FROM imported_files WHERE id = ?', id);
    return row ? toImportedFile(row) : undefined;
  },

  /** Video files of a download, oldest first — one per episode for a batch. */
  videosFor(downloadId: number): ImportedFile[] {
    return all<Record<string, unknown>>(
      `SELECT * FROM imported_files WHERE download_id = ? AND kind = 'video' ORDER BY episode, id`,
      downloadId
    ).map(toImportedFile);
  },

  /**
   * Sidecar subtitles that belong with a video. Episode is the join key: a
   * batch import puts several episodes' subtitles under one download id.
   */
  subtitlesFor(downloadId: number, episode?: number): ImportedFile[] {
    const rows =
      episode === undefined
        ? all<Record<string, unknown>>(
            `SELECT * FROM imported_files WHERE download_id = ? AND kind = 'subtitle' ORDER BY id`,
            downloadId
          )
        : all<Record<string, unknown>>(
            `SELECT * FROM imported_files
             WHERE download_id = ? AND kind = 'subtitle' AND (episode IS NULL OR episode = ?)
             ORDER BY id`,
            downloadId,
            episode
          );
    return rows.map(toImportedFile);
  }
};

// --- playback progress -----------------------------------------------------

/** Local watched/resume state. Only written when the built-in player is in use. */
export interface PlaybackProgress {
  importedFileId: number;
  positionMs: number;
  durationMs?: number;
  played: boolean;
  updatedAt: number;
}

/** Past this fraction of the runtime an episode counts as watched, as Jellyfin does. */
export const PLAYED_THRESHOLD = 0.9;

function toProgress(row: Record<string, unknown>): PlaybackProgress {
  return {
    importedFileId: Number(row.imported_file_id),
    positionMs: Number(row.position_ms),
    durationMs: num(row.duration_ms),
    played: Number(row.played) === 1,
    updatedAt: Number(row.updated_at)
  };
}

export const playbackProgress = {
  find(importedFileId: number): PlaybackProgress | undefined {
    const row = get<Record<string, unknown>>(
      'SELECT * FROM playback_progress WHERE imported_file_id = ?',
      importedFileId
    );
    return row ? toProgress(row) : undefined;
  },

  /** One query for a whole page of the library rather than one per row. */
  forFiles(importedFileIds: number[]): Map<number, PlaybackProgress> {
    if (importedFileIds.length === 0) return new Map();
    const rows = all<Record<string, unknown>>(
      `SELECT * FROM playback_progress
       WHERE imported_file_id IN (${importedFileIds.map(() => '?').join(', ')})`,
      ...importedFileIds
    );
    return new Map(rows.map((row) => [Number(row.imported_file_id), toProgress(row)]));
  },

  save(input: {
    importedFileId: number;
    positionMs: number;
    durationMs?: number;
    played?: boolean;
  }): PlaybackProgress {
    const played =
      input.played ??
      (input.durationMs !== undefined &&
        input.durationMs > 0 &&
        input.positionMs / input.durationMs >= PLAYED_THRESHOLD);

    run(
      `INSERT INTO playback_progress (imported_file_id, position_ms, duration_ms, played, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(imported_file_id) DO UPDATE SET
         position_ms = excluded.position_ms,
         duration_ms = COALESCE(excluded.duration_ms, playback_progress.duration_ms),
         -- Watched is sticky: finishing an episode then rewatching the first
         -- minute must not push it back into the "new" list.
         played      = MAX(playback_progress.played, excluded.played),
         updated_at  = excluded.updated_at`,
      input.importedFileId,
      Math.max(0, Math.round(input.positionMs)),
      input.durationMs === undefined ? null : Math.round(input.durationMs),
      played ? 1 : 0,
      Date.now()
    );
    return this.find(input.importedFileId)!;
  },

  setPlayed(importedFileId: number, played: boolean): void {
    run(
      `INSERT INTO playback_progress (imported_file_id, position_ms, played, updated_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(imported_file_id) DO UPDATE SET
         played      = excluded.played,
         -- Marking unwatched clears the resume point; marking watched keeps it.
         position_ms = CASE WHEN excluded.played = 1 THEN playback_progress.position_ms ELSE 0 END,
         updated_at  = excluded.updated_at`,
      importedFileId,
      played ? 1 : 0,
      Date.now()
    );
  }
};

// --- media probe cache -----------------------------------------------------

export interface MediaProbeRow {
  importedFileId: number;
  size: number;
  mtimeMs: number;
  durationMs?: number;
  container?: string;
  streamsJson: string;
  keyframesJson?: string;
  probedAt: number;
}

export const mediaProbe = {
  /** Returns the cached probe only if the file on disk still matches it. */
  find(importedFileId: number, size: number, mtimeMs: number): MediaProbeRow | undefined {
    const row = get<Record<string, unknown>>(
      'SELECT * FROM media_probe WHERE imported_file_id = ?',
      importedFileId
    );
    if (!row) return undefined;
    if (Number(row.size) !== size || Number(row.mtime_ms) !== Math.round(mtimeMs)) return undefined;
    return {
      importedFileId: Number(row.imported_file_id),
      size: Number(row.size),
      mtimeMs: Number(row.mtime_ms),
      durationMs: num(row.duration_ms),
      container: str(row.container),
      streamsJson: String(row.streams_json),
      keyframesJson: str(row.keyframes_json),
      probedAt: Number(row.probed_at)
    };
  },

  save(input: Omit<MediaProbeRow, 'probedAt'>): void {
    run(
      `INSERT INTO media_probe
         (imported_file_id, size, mtime_ms, duration_ms, container, streams_json, keyframes_json, probed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(imported_file_id) DO UPDATE SET
         size = excluded.size, mtime_ms = excluded.mtime_ms,
         duration_ms = excluded.duration_ms, container = excluded.container,
         streams_json = excluded.streams_json,
         -- A keyframe scan is expensive; keep the old one unless a new one came.
         keyframes_json = COALESCE(excluded.keyframes_json, media_probe.keyframes_json),
         probed_at = excluded.probed_at`,
      input.importedFileId,
      input.size,
      Math.round(input.mtimeMs),
      input.durationMs ?? null,
      input.container ?? null,
      input.streamsJson,
      input.keyframesJson ?? null,
      Date.now()
    );
  }
};

// --- events ----------------------------------------------------------------

export function recentEvents(limit = 100) {
  return all<Record<string, unknown>>(
    'SELECT * FROM events ORDER BY id DESC LIMIT ?',
    limit
  ).map((row) => ({
    id: Number(row.id),
    level: String(row.level),
    scope: String(row.scope),
    message: String(row.message),
    data: parseJson<Record<string, unknown> | null>(row.data, null),
    createdAt: Number(row.created_at)
  }));
}
