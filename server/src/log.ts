import { run } from './db/index.ts';

export type Level = 'info' | 'warn' | 'error';

const MAX_EVENTS = 2000;

let sinceTrim = 0;

/**
 * Log to stdout and to the `events` table, which backs the UI activity feed.
 * A failure to persist must never take down the caller — the console line is
 * the source of truth, the table is a convenience.
 */
export function logEvent(
  level: Level,
  scope: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const line = `[${level}] ${scope}: ${message}`;
  if (level === 'error') console.error(line, data ?? '');
  else if (level === 'warn') console.warn(line, data ?? '');
  else console.log(line, data ?? '');

  try {
    run(
      'INSERT INTO events (level, scope, message, data, created_at) VALUES (?, ?, ?, ?, ?)',
      level,
      scope,
      message,
      data ? JSON.stringify(data) : null,
      Date.now()
    );

    // Trim occasionally rather than on every insert; this table is chatty.
    if (++sinceTrim >= 200) {
      sinceTrim = 0;
      run(
        `DELETE FROM events WHERE id NOT IN (
           SELECT id FROM events ORDER BY id DESC LIMIT ?
         )`,
        MAX_EVENTS
      );
    }
  } catch {
    // Database not ready yet, or mid-migration. Console output already happened.
  }
}

export const log = {
  info: (scope: string, message: string, data?: Record<string, unknown>) =>
    logEvent('info', scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) =>
    logEvent('warn', scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) =>
    logEvent('error', scope, message, data)
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
