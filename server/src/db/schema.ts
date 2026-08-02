/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 * Only ever append to this array — never edit a shipped entry, or databases in
 * the field will silently skip the change.
 */
export const MIGRATIONS: string[] = [
  /* 1 */ `
  -- Bangumi subject cache. Populated on demand, refreshed on a TTL, so browsing
  -- a series repeatedly costs one bgm.tv request rather than one per page view.
  CREATE TABLE subjects (
    id          INTEGER PRIMARY KEY,          -- bangumi subject id
    name        TEXT    NOT NULL,             -- original title (usually ja)
    name_cn     TEXT,
    summary     TEXT,
    air_date    TEXT,                         -- YYYY-MM-DD
    eps         INTEGER,
    score       REAL,
    rank        INTEGER,
    platform    TEXT,
    tags        TEXT,                         -- JSON string[]
    images      TEXT,                         -- JSON {large,common,medium,...}
    infobox     TEXT,                         -- JSON, holds studio/staff
    episodes    TEXT,                         -- JSON BangumiEpisode[]
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE subscriptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id      INTEGER NOT NULL,
    title           TEXT    NOT NULL,         -- display name
    season          INTEGER NOT NULL DEFAULT 1,
    episode_offset  INTEGER NOT NULL DEFAULT 0,
    filter_json     TEXT    NOT NULL DEFAULT '{}',
    library_folder  TEXT    NOT NULL,         -- e.g. "葬送的芙莉莲 (2023)"
    enabled         INTEGER NOT NULL DEFAULT 1,
    auto_download   INTEGER NOT NULL DEFAULT 1,
    last_checked_at INTEGER,
    cursor_at       INTEGER,                  -- newest resource createdAt seen (ms)
    created_at      INTEGER NOT NULL
  );

  CREATE INDEX idx_subscriptions_subject ON subscriptions(subject_id);
  CREATE INDEX idx_subscriptions_enabled ON subscriptions(enabled);

  CREATE TABLE downloads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE CASCADE,
    resource_id     INTEGER,                  -- animegarden resource id
    provider        TEXT,
    provider_id     TEXT,
    title           TEXT    NOT NULL,
    magnet          TEXT    NOT NULL,
    -- Always lowercase hex, normalized from the magnet's hex OR base32 form.
    info_hash       TEXT    NOT NULL UNIQUE,
    size            INTEGER,                  -- KB, as AnimeGarden reports it
    fansub          TEXT,
    season          INTEGER,
    episode         REAL,                     -- 27, or 27.5 for a 总集篇
    episode_to      REAL,                     -- set for batch releases (01-24)
    status          TEXT    NOT NULL,
    needs_review    INTEGER NOT NULL DEFAULT 0,
    qb_state        TEXT,
    qb_progress     REAL    NOT NULL DEFAULT 0,
    content_path    TEXT,
    error           TEXT,
    added_at        INTEGER NOT NULL,
    completed_at    INTEGER,
    imported_at     INTEGER
  );

  CREATE INDEX idx_downloads_sub    ON downloads(subscription_id);
  CREATE INDEX idx_downloads_status ON downloads(status);

  -- One episode per subscription reaches the library; whichever fansub lands
  -- first wins and later duplicates are marked 'skipped' rather than
  -- overwriting a file Jellyfin may already have scanned.
  CREATE UNIQUE INDEX idx_downloads_episode_claim
    ON downloads(subscription_id, season, episode)
    WHERE status = 'imported' AND episode IS NOT NULL;

  CREATE TABLE imported_files (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    download_id  INTEGER REFERENCES downloads(id) ON DELETE CASCADE,
    source_path  TEXT    NOT NULL,
    library_path TEXT    NOT NULL,
    episode      REAL,
    kind         TEXT    NOT NULL,            -- video | subtitle | metadata | artwork
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX idx_imported_download ON imported_files(download_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    level      TEXT NOT NULL,                 -- info | warn | error
    scope      TEXT NOT NULL,                 -- poller | qbittorrent | importer | ...
    message    TEXT NOT NULL,
    data       TEXT,                          -- JSON
    created_at INTEGER NOT NULL
  );

  CREATE INDEX idx_events_created ON events(created_at DESC);
  `
];
