/**
 * Running ffmpeg and ffprobe.
 *
 * The decisions all live in media.ts; this file only spawns processes, caches
 * the expensive answers, and keeps concurrency bounded so a Pi cannot be
 * knocked over by a player prefetching segments.
 */
import { spawn } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

import { config } from '../config.ts';
import { mediaProbe, type ImportedFile } from '../data.ts';
import { resolveWithin } from './paths.ts';
import {
  keyframeProbeArgs,
  parseKeyframes,
  parseProbe,
  probeArgs,
  offsetFragmentTimestamps,
  parseTrackTimescales,
  splitFragmentedMp4,
  attachmentDumpArgs,
  chooseH264Encoder,
  initSegmentArgs,
  mediaSegmentArgs,
  subtitleExtractArgs,
  DEFAULT_H264_ENCODER,
  type MediaInfo,
  type PlayPlan,
  type Segment
} from './media.ts';

export class FfmpegError extends Error {}

/**
 * How many ffmpeg processes may run at once.
 *
 * Segments are now generated ahead of playback rather than in front of it, so
 * this sets how fast the cache can fill — but each ffmpeg is itself
 * multi-threaded, and running more of them than the box can feed makes every
 * one of them slower. Half the available cores, bounded at both ends: two on a
 * Raspberry Pi, a handful on a desktop. Work over the limit waits rather than
 * being refused, because a player has no useful way to retry.
 */
const MAX_CONCURRENT = Math.max(2, Math.min(6, Math.floor(availableParallelism() / 2)));
/** Refuse to buffer more than this from one process. A 6s segment is ~2-10MB. */
const MAX_OUTPUT_BYTES = 192 * 1024 * 1024;

/**
 * Read-ahead may use every slot but one.
 *
 * Without this, a player that asks for a segment nobody predicted — after a
 * seek, say — queues behind four background jobs and waits seconds for work
 * that takes one. Leaving a slot free means an unpredicted request starts
 * almost immediately, which matters far more than filling the cache a little
 * sooner.
 */
const MAX_BACKGROUND = Math.max(1, MAX_CONCURRENT - 1);

export type Priority = 'interactive' | 'background';

let running = 0;
let background = 0;
const waiting: Array<{ priority: Priority; resume: () => void }> = [];

function canStart(priority: Priority): boolean {
  if (running >= MAX_CONCURRENT) return false;
  return priority === 'interactive' || background < MAX_BACKGROUND;
}

/** Wake the longest-waiting job that is allowed to run, interactive first. */
function pump(): void {
  for (const priority of ['interactive', 'background'] as const) {
    const index = waiting.findIndex((w) => w.priority === priority);
    if (index === -1 || !canStart(priority)) continue;
    const [next] = waiting.splice(index, 1);
    next?.resume();
    return;
  }
}

async function acquire(priority: Priority): Promise<() => void> {
  if (!canStart(priority)) {
    await new Promise<void>((resume) => waiting.push({ priority, resume }));
  }
  running++;
  if (priority === 'background') background++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    running--;
    if (priority === 'background') background--;
    pump();
  };
}

/** Run a process and buffer its stdout. Rejects on a non-zero exit. */
function capture(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        reject(new FfmpegError(`${bin} produced more than ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Keep only the tail: ffmpeg is happy to write megabytes of warnings.
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    child.on('error', (error) =>
      reject(
        new FfmpegError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? `${bin} is not installed in this container`
            : `${bin} failed to start: ${error.message}`
        )
      )
    );
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new FfmpegError(`${bin} exited ${code}: ${stderr.trim() || 'no output'}`))
    );
  });
}

/** Run a process under the concurrency limit. */
async function captureLimited(
  bin: string,
  args: string[],
  priority: Priority = 'interactive'
): Promise<Buffer> {
  const release = await acquire(priority);
  try {
    return await capture(bin, args);
  } finally {
    release();
  }
}

/** Whether ffmpeg and ffprobe are present, for the health and settings pages. */
export async function ffmpegVersion(): Promise<string> {
  const output = await capture('ffmpeg', ['-hide_banner', '-version']);
  const first = output.toString('utf8').split('\n')[0] ?? '';
  return first.replace(/^ffmpeg version /, '').split(' ')[0] ?? 'unknown';
}

/**
 * Which H.264 encoder this ffmpeg build actually has, asked once.
 *
 * Builds differ: the shipped image has libx264, a distribution's patent-free
 * package may have only OpenH264, and a Pi has a hardware encoder worth
 * preferring over both. Hard-coding libx264 would make transcoding fail on all
 * but the first.
 */
let encoderChoice: Promise<string> | undefined;
export function h264Encoder(): Promise<string> {
  encoderChoice ??= capture('ffmpeg', ['-hide_banner', '-encoders'])
    .then((output) => chooseH264Encoder(output.toString('utf8')))
    .catch(() => DEFAULT_H264_ENCODER);
  return encoderChoice;
}

// --- probing ---------------------------------------------------------------

/**
 * Every path handed to ffmpeg is checked against LIBRARY_ROOT first. Rows come
 * from the importer so they are already inside it; this makes that a guarantee
 * rather than an assumption.
 */
function safePath(file: ImportedFile): string {
  return resolveWithin(config.LIBRARY_ROOT, file.libraryPath);
}

export interface ProbedFile {
  path: string;
  info: MediaInfo;
  size: number;
  mtimeMs: number;
}

/**
 * ffprobe a library file, reusing the cached result while the file on disk is
 * unchanged. Size and mtime are the cache key; a re-import replaces the
 * hardlink and invalidates it naturally.
 */
export async function probeFile(file: ImportedFile): Promise<ProbedFile> {
  const path = safePath(file);
  const stats = await stat(path);
  const size = stats.size;
  const mtimeMs = Math.round(stats.mtimeMs);

  const cached = mediaProbe.find(file.id, size, mtimeMs);
  if (cached) {
    return {
      path,
      size,
      mtimeMs,
      info: {
        container: cached.container ?? 'unknown',
        durationMs: cached.durationMs ?? 0,
        streams: JSON.parse(cached.streamsJson) as MediaInfo['streams']
      }
    };
  }

  const info = parseProbe((await captureLimited('ffprobe', probeArgs(path))).toString('utf8'));
  mediaProbe.save({
    importedFileId: file.id,
    size,
    mtimeMs,
    durationMs: info.durationMs,
    container: info.container,
    streamsJson: JSON.stringify(info.streams)
  });
  return { path, info, size, mtimeMs };
}

/**
 * Keyframe timestamps, cached separately because only the copy path needs
 * them and the scan reads the whole file.
 */
export async function keyframesFor(file: ImportedFile, probed: ProbedFile): Promise<number[]> {
  const cached = mediaProbe.find(file.id, probed.size, probed.mtimeMs);
  if (cached?.keyframesJson) return JSON.parse(cached.keyframesJson) as number[];

  const csv = (await captureLimited('ffprobe', keyframeProbeArgs(probed.path))).toString('utf8');
  const keyframes = parseKeyframes(csv);

  mediaProbe.save({
    importedFileId: file.id,
    size: probed.size,
    mtimeMs: probed.mtimeMs,
    durationMs: probed.info.durationMs,
    container: probed.info.container,
    streamsJson: JSON.stringify(probed.info.streams),
    keyframesJson: JSON.stringify(keyframes)
  });
  return keyframes;
}

// --- segments --------------------------------------------------------------

export interface InitSegment {
  bytes: Buffer;
  /** trackID → timescale, needed to place every later segment on the timeline. */
  timescales: Map<number, number>;
}

/**
 * Init segments are tiny, identical for every viewer of the same plan, and
 * needed by every media segment as well as by the player — worth a small
 * cache, unlike media segments, which a player asks for once and then keeps
 * in its own buffer.
 */
const INIT_CACHE = new Map<string, InitSegment>();
const INIT_CACHE_MAX = 32;

export async function initSegment(
  path: string,
  plan: PlayPlan,
  key: string
): Promise<InitSegment> {
  const cached = INIT_CACHE.get(key);
  if (cached) return cached;

  const output = await captureLimited('ffmpeg', initSegmentArgs(path, plan, await h264Encoder()));
  const { init } = splitFragmentedMp4(output);
  const entry: InitSegment = { bytes: init, timescales: parseTrackTimescales(init) };

  if (INIT_CACHE.size >= INIT_CACHE_MAX) {
    const oldest = INIT_CACHE.keys().next().value;
    if (oldest !== undefined) INIT_CACHE.delete(oldest);
  }
  INIT_CACHE.set(key, entry);
  return entry;
}

export async function mediaSegment(
  path: string,
  plan: PlayPlan,
  segment: Segment,
  key: string,
  priority: Priority = 'interactive'
): Promise<Buffer> {
  // The init segment carries the track timescales, and is cached after the
  // first request, so this is a map lookup for every segment but the first.
  const { timescales } = await initSegment(path, plan, key);

  const output = await captureLimited(
    'ffmpeg',
    mediaSegmentArgs(path, plan, segment, await h264Encoder()),
    priority
  );
  const { media } = splitFragmentedMp4(output);
  if (media.length === 0) {
    throw new FfmpegError(`ffmpeg produced no fragment for segment ${segment.index}`);
  }
  return offsetFragmentTimestamps(media, segment.startMs, timescales);
}

// --- subtitles and fonts ---------------------------------------------------

export async function extractSubtitle(
  path: string,
  typeIndex: number,
  format: 'ass' | 'webvtt'
): Promise<string> {
  const output = await captureLimited('ffmpeg', subtitleExtractArgs(path, typeIndex, format));
  return output.toString('utf8');
}

/**
 * Read one attachment out of a Matroska file.
 *
 * ffmpeg can only dump attachments to a real file, so this goes via a temp
 * path that is removed either way.
 */
export async function extractAttachment(path: string, typeIndex: number): Promise<Buffer> {
  const target = join(
    tmpdir(),
    `haro-attachment-${process.pid}-${Date.now()}-${typeIndex}.bin`
  );
  try {
    await captureLimited('ffmpeg', attachmentDumpArgs(path, typeIndex, target));
    return await readFile(target);
  } finally {
    await rm(target, { force: true }).catch(() => {});
  }
}
