import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../config.ts';
import { MIGRATIONS } from './schema.ts';

export type Row = Record<string, unknown>;

let handle: DatabaseSync | undefined;

export function db(): DatabaseSync {
  if (!handle) handle = open();
  return handle;
}

function open(): DatabaseSync {
  mkdirSync(config.DATA_DIR, { recursive: true });
  const file = config.NODE_ENV === 'test' ? ':memory:' : join(config.DATA_DIR, 'haro.db');

  const database = new DatabaseSync(file, { enableForeignKeyConstraints: true });

  // WAL keeps the poller's writes from blocking UI reads. On a Pi with an SD
  // card, NORMAL sync is the difference between snappy and unusable, and the
  // worst case on power loss is losing the last few seconds of download state
  // — all of it recoverable by re-polling.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec('PRAGMA busy_timeout = 5000');

  migrate(database);
  return database;
}

function migrate(database: DatabaseSync): void {
  const current = Number(
    (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  );

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Migration ${version + 1} failed: ${(error as Error).message}`, {
        cause: error
      });
    }
  }
}

/** Reset the module-level handle. Used by tests. */
export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

// --- small helpers ---------------------------------------------------------

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db()
    .prepare(sql)
    .all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db()
    .prepare(sql)
    .get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return db()
    .prepare(sql)
    .run(...(params as never[]));
}

/** Parse a JSON column, falling back rather than throwing on corrupt rows. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
