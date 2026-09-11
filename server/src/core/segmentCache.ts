/**
 * On-disk cache for generated HLS segments, with read-ahead.
 *
 * Segments are produced by a short-lived ffmpeg per request, which keeps the
 * server stateless but puts the whole generation cost — most of a second for
 * 1080p — in front of every single fetch. A player asks for segments one at a
 * time, so that latency is paid serially for the entire episode, and seeking
 * pays it again for ground already covered.
 *
 * Caching turns a repeat request into a file read. Read-ahead turns the common
 * case — playing forwards — into one too: serving segment N starts N+1 and its
 * neighbours in the background, so by the time the player asks, they are
 * already there. Generation still happens at the same speed; it just stops
 * being what the player waits for.
 *
 * The cache is disposable. Anything in it can be regenerated from the source
 * file, so it is pruned by age without ceremony and losing it costs nothing.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../config.ts';
import { log } from '../log.ts';

/** How many segments past the one being served to prepare in the background. */
const READ_AHEAD = 4;
/** Total budget for cached segments. Pruned back to this when exceeded. */
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** Prune no more often than this, however many segments are served. */
const PRUNE_INTERVAL_MS = 60_000;

const root = () => join(config.DATA_DIR, 'cache', 'segments');

/**
 * A plan key can be long and contains characters a filename should not carry
 * (the capability list, for one), so address directories by digest instead.
 */
function planDir(fileId: number, planKey: string): string {
  const digest = createHash('sha1').update(planKey).digest('hex').slice(0, 16);
  return join(root(), String(fileId), digest);
}

const segmentFile = (dir: string, index: number) => join(dir, `${index}.m4s`);

/** Segments currently being generated, so read-ahead never duplicates work. */
const inFlight = new Map<string, Promise<Buffer>>();

export async function readCachedSegment(
  fileId: number,
  planKey: string,
  index: number
): Promise<Buffer | undefined> {
  try {
    const path = segmentFile(planDir(fileId, planKey), index);
    // A zero-length file would be a crashed write; treat it as a miss.
    if ((await stat(path)).size === 0) return undefined;
    return await readFile(path);
  } catch {
    return undefined;
  }
}

async function writeCachedSegment(
  fileId: number,
  planKey: string,
  index: number,
  bytes: Buffer
): Promise<void> {
  const dir = planDir(fileId, planKey);
  await mkdir(dir, { recursive: true });
  // Write then rename: a reader must never see a half-written segment.
  const temp = `${segmentFile(dir, index)}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, segmentFile(dir, index));
}

/**
 * Fetch a segment, from cache if possible, generating it otherwise.
 *
 * `generate` is only ever called once per segment even when several requests
 * (or a read-ahead) arrive together.
 */
export async function segmentWithCache(
  fileId: number,
  planKey: string,
  index: number,
  generate: () => Promise<Buffer>
): Promise<Buffer> {
  const cached = await readCachedSegment(fileId, planKey, index);
  if (cached) return cached;

  const key = `${fileId}:${planKey}:${index}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const bytes = await generate();
    await writeCachedSegment(fileId, planKey, index, bytes).catch((error: unknown) => {
      // A cache that cannot be written is a slow cache, not a broken player.
      log.warn('player', 'could not cache a segment', { error: String(error) });
    });
    return bytes;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return work;
}

/**
 * Prepare the segments after `index` in the background.
 *
 * Deliberately not awaited by the request that triggers it: the point is to
 * use the time between one fetch and the next, not to make the current fetch
 * slower. Failures are ignored — the segment will simply be generated on
 * demand like it used to be.
 */
export function readAhead(
  fileId: number,
  planKey: string,
  index: number,
  total: number,
  generate: (index: number) => Promise<Buffer>
): void {
  for (let next = index + 1; next <= index + READ_AHEAD && next < total; next++) {
    const target = next;
    void segmentWithCache(fileId, planKey, target, () => generate(target)).catch(() => {});
  }
}

// --- pruning ---------------------------------------------------------------

let lastPrune = 0;

/** Every cached segment, with its size and when it was last used. */
async function listSegments(): Promise<Array<{ path: string; size: number; atime: number }>> {
  const found: Array<{ path: string; size: number; atime: number }> = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.m4s')) {
        const info = await stat(path).catch(() => undefined);
        if (info) found.push({ path, size: info.size, atime: info.atimeMs || info.mtimeMs });
      }
    }
  }

  await walk(root());
  return found;
}

/**
 * Drop the least recently used segments until the cache fits its budget.
 *
 * Rate-limited rather than run per request: the budget is a ceiling to stay
 * under, not a line to hold exactly.
 */
export async function pruneCache(): Promise<void> {
  if (Date.now() - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = Date.now();

  try {
    const segments = await listSegments();
    let total = segments.reduce((sum, s) => sum + s.size, 0);
    if (total <= MAX_BYTES) return;

    segments.sort((a, b) => a.atime - b.atime); // oldest use first
    let removed = 0;
    for (const segment of segments) {
      if (total <= MAX_BYTES) break;
      await rm(segment.path, { force: true });
      total -= segment.size;
      removed++;
    }
    log.info('player', `pruned ${removed} cached segment(s)`, { remainingBytes: total });
  } catch (error) {
    log.warn('player', 'segment cache prune failed', { error: String(error) });
  }
}

/** Forget everything cached for one file, e.g. when it is re-imported. */
export async function dropCacheFor(fileId: number): Promise<void> {
  await rm(join(root(), String(fileId)), { recursive: true, force: true }).catch(() => {});
}
