import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';

import { config } from '../config.ts';
import { downloads, importedFiles, playbackProgress, subscriptions } from '../data.ts';
import type { ImportedFile } from '../data.ts';
import type { Priority } from '../core/ffmpeg.ts';
import {
  extractAttachment,
  extractSubtitle,
  initSegment,
  keyframesFor,
  mediaSegment,
  probeFile,
  type ProbedFile
} from '../core/ffmpeg.ts';
import { resolveWithin } from '../core/paths.ts';
import { pruneCache, readAhead, segmentWithCache } from '../core/segmentCache.ts';
import {
  attachmentStreams,
  audioStreams,
  decidePlayback,
  describePlan,
  parseCapabilities,
  segmentPlan,
  buildPlaylist,
  subtitleStreams,
  TEXT_SUBTITLE_CODECS,
  videoStreams,
  type PlayPlan,
  type Segment
} from '../core/media.ts';
import { errorMessage } from '../log.ts';

/** A subtitle the player can offer: either an embedded track or a sidecar file. */
interface SubtitleTrack {
  id: string;
  label: string;
  language?: string;
  format: 'ass' | 'webvtt';
  source: 'embedded' | 'sidecar';
  isDefault: boolean;
  forced: boolean;
  url: string;
}

interface AudioTrack {
  index: number;
  label: string;
  language?: string;
  codec: string;
  channels?: number;
  isDefault: boolean;
}

/**
 * Everything a plan depends on, folded into one string.
 *
 * Segment URLs carry it so that changing audio track or arriving with
 * different browser capabilities produces a different playlist rather than
 * silently reusing segments built for someone else's decoder.
 */
function planKey(plan: PlayPlan, capsRaw: string): string {
  const video = plan.video ? `v${plan.video.typeIndex}${plan.video.action[0]}` : 'vn';
  const audio = plan.audio ? `a${plan.audio.typeIndex}${plan.audio.action[0]}` : 'an';
  return `${video}.${audio}.${capsRaw || 'default'}`;
}

function trackLabel(
  kind: string,
  title: string | undefined,
  language: string | undefined,
  fallbackIndex: number
): string {
  if (title) return title;
  if (language) return language;
  return `${kind} ${fallbackIndex + 1}`;
}

/** Load the imported file plus the context needed to describe it. */
function loadFile(fileId: number) {
  const file = importedFiles.find(fileId);
  if (!file || file.kind !== 'video') return undefined;

  const download = downloads.find(file.downloadId);
  const subscription = download?.subscriptionId
    ? subscriptions.find(download.subscriptionId)
    : undefined;
  return { file, download, subscription };
}

function collectSubtitles(file: ImportedFile, probed: ProbedFile): SubtitleTrack[] {
  const tracks: SubtitleTrack[] = [];

  for (const stream of subtitleStreams(probed.info)) {
    const format = TEXT_SUBTITLE_CODECS[stream.codec];
    // PGS and VobSub are bitmaps; showing them means burning them into the
    // video, which is a different (and much more expensive) job.
    if (!format) continue;
    tracks.push({
      id: `embedded-${stream.typeIndex}`,
      label: trackLabel('Subtitles', stream.title, stream.language, stream.typeIndex),
      language: stream.language,
      format,
      source: 'embedded',
      isDefault: stream.isDefault,
      forced: stream.forced,
      url: `/api/play/${file.id}/subtitles/embedded-${stream.typeIndex}`
    });
  }

  for (const sidecar of importedFiles.subtitlesFor(file.downloadId, file.episode)) {
    const extension = extname(sidecar.libraryPath).toLowerCase();
    const format = extension === '.ass' || extension === '.ssa' ? 'ass' : 'webvtt';
    // "Show S01E12.zh-Hans.ass" → "zh-Hans"
    const language = basename(sidecar.libraryPath, extension).split('.').slice(1).pop();
    tracks.push({
      id: `sidecar-${sidecar.id}`,
      label: language ? `${language} (file)` : basename(sidecar.libraryPath),
      language,
      format,
      source: 'sidecar',
      isDefault: false,
      forced: false,
      url: `/api/play/${file.id}/subtitles/sidecar-${sidecar.id}`
    });
  }

  return tracks;
}

function collectAudio(probed: ProbedFile): AudioTrack[] {
  return audioStreams(probed.info).map((stream) => ({
    index: stream.typeIndex,
    label: trackLabel('Audio', stream.title, stream.language, stream.typeIndex),
    language: stream.language,
    codec: stream.codec,
    channels: stream.channels,
    isDefault: stream.isDefault
  }));
}

/** Serve a whole file with Range support, for the direct-play path. */
async function serveRange(
  path: string,
  rangeHeader: string | undefined,
  contentType: string
): Promise<Response> {
  const { size } = await stat(path);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600'
  };

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader?.trim() ?? '');
  if (!match) {
    headers['Content-Length'] = String(size);
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { headers });
  }

  const [, rawStart, rawEnd] = match;
  // `bytes=-500` means the last 500 bytes, not "from 0 to 500".
  const suffix = rawStart === '';
  const start = suffix ? Math.max(0, size - Number(rawEnd || 0)) : Number(rawStart);
  const end = suffix || rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);

  if (!Number.isFinite(start) || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(
    Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream,
    { status: 206, headers }
  );
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska'
};

export const playRoutes = new Hono()
  /**
   * Everything the player needs to start: how this file will be delivered to
   * this browser, what tracks it has, and where you left off.
   */
  .get('/:fileId/info', async (c) => {
    const found = loadFile(Number(c.req.param('fileId')));
    if (!found) return c.json({ error: 'Not found' }, 404);
    const { file, download, subscription } = found;

    const capsRaw = c.req.query('caps') ?? '';
    const audioParam = c.req.query('audio');
    const audioTrack = audioParam === undefined ? undefined : Number(audioParam);

    let probed: ProbedFile;
    try {
      probed = await probeFile(file);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }

    const plan = decidePlayback(probed.info, parseCapabilities(capsRaw), {
      audioTrack: Number.isFinite(audioTrack) ? audioTrack : undefined,
      extension: extname(probed.path)
    });
    const query = new URLSearchParams({ caps: capsRaw });
    if (plan.audio) query.set('audio', String(plan.audio.typeIndex));

    const video = videoStreams(probed.info)[0];
    const progress = playbackProgress.find(file.id);

    return c.json({
      fileId: file.id,
      downloadId: file.downloadId,
      subscriptionId: subscription?.id ?? null,
      seriesTitle: subscription?.title ?? download?.title ?? basename(file.libraryPath),
      season: download?.season ?? subscription?.season ?? 1,
      episode: file.episode ?? download?.episode ?? null,
      durationMs: probed.info.durationMs,
      width: video?.width ?? null,
      height: video?.height ?? null,
      delivery: describePlan(plan),
      reasons: plan.reasons,
      streamUrl:
        plan.mode === 'direct'
          ? `/api/play/${file.id}/direct`
          : `/api/play/${file.id}/hls/main.m3u8?${query}`,
      audioTracks: collectAudio(probed),
      selectedAudio: plan.audio?.typeIndex ?? null,
      subtitleTracks: collectSubtitles(file, probed),
      fonts: attachmentStreams(probed.info)
        .filter((s) => /font|otf|ttf/i.test(`${s.mimetype ?? ''} ${s.filename ?? ''}`))
        .map((s) => `/api/play/${file.id}/fonts/${s.typeIndex}`),
      resume: progress
        ? { positionMs: progress.positionMs, played: progress.played }
        : { positionMs: 0, played: false }
    });
  })

  /** The original file, byte-ranged. Only offered when nothing needs changing. */
  .get('/:fileId/direct', async (c) => {
    const found = loadFile(Number(c.req.param('fileId')));
    if (!found) return c.json({ error: 'Not found' }, 404);

    try {
      const probed = await probeFile(found.file);
      const type = MIME_BY_EXTENSION[extname(probed.path).toLowerCase()] ?? 'video/mp4';
      return await serveRange(probed.path, c.req.header('Range'), type);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  })

  /**
   * The playlist, written in full from the segment plan before a single
   * segment exists — which is what lets the player seek anywhere immediately.
   */
  .get('/:fileId/hls/main.m3u8', async (c) => {
    const prepared = await prepare(c.req.param('fileId'), c.req.query());
    if ('error' in prepared) return c.json({ error: prepared.error }, prepared.status);
    const { plan, segments, capsRaw } = prepared;

    const query = new URLSearchParams({ caps: capsRaw, key: planKey(plan, capsRaw) });
    if (plan.audio) query.set('audio', String(plan.audio.typeIndex));

    const playlist = buildPlaylist(
      segments,
      (segment: Segment) => `${segment.index}.m4s?${query}`,
      `init.mp4?${query}`
    );
    return c.body(playlist, 200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Cache-Control': 'no-store'
    });
  })

  /** Stream configuration, referenced once per playlist by #EXT-X-MAP. */
  .get('/:fileId/hls/init.mp4', async (c) => {
    const prepared = await prepare(c.req.param('fileId'), c.req.query());
    if ('error' in prepared) return c.json({ error: prepared.error }, prepared.status);
    const { file, plan, path, capsRaw } = prepared;

    try {
      const { bytes } = await initSegment(path, plan, `${file.id}:${planKey(plan, capsRaw)}`);
      return c.body(toArrayBuffer(bytes), 200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'private, max-age=3600'
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  })

  /**
   * One segment.
   *
   * Served from the cache when it is there, and generated otherwise — after
   * which the next few are prepared in the background, so a player working
   * forwards stops waiting on ffmpeg entirely after the first one.
   */
  .get('/:fileId/hls/:segment{[0-9]+\\.m4s}', async (c) => {
    const prepared = await prepare(c.req.param('fileId'), c.req.query());
    if ('error' in prepared) return c.json({ error: prepared.error }, prepared.status);
    const { file, plan, path, segments, capsRaw } = prepared;

    const index = Number(c.req.param('segment').replace('.m4s', ''));
    const segment = segments[index];
    if (!segment) return c.json({ error: 'No such segment' }, 404);

    const key = planKey(plan, capsRaw);
    const build = (at: number, priority: Priority) => {
      const target = segments[at];
      if (!target) return Promise.reject(new Error(`No such segment ${at}`));
      return mediaSegment(path, plan, target, `${file.id}:${key}`, priority);
    };

    try {
      // The segment being asked for is what playback is waiting on; the ones
      // after it are a guess, and must never delay the real thing.
      const body = await segmentWithCache(file.id, key, index, () =>
        build(index, 'interactive')
      );
      readAhead(file.id, key, index, segments.length, (at) => build(at, 'background'));
      void pruneCache();

      return c.body(toArrayBuffer(body), 200, {
        'Content-Type': 'video/iso.segment',
        // Immutable in practice: the same plan and index always produce the
        // same bytes, so a re-seek should never come back to the server.
        'Cache-Control': 'private, max-age=86400, immutable'
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  })

  /** One subtitle track, embedded or sidecar. */
  .get('/:fileId/subtitles/:track', async (c) => {
    const found = loadFile(Number(c.req.param('fileId')));
    if (!found) return c.json({ error: 'Not found' }, 404);

    const track = c.req.param('track');
    try {
      if (track.startsWith('sidecar-')) {
        const sidecar = importedFiles.find(Number(track.slice('sidecar-'.length)));
        if (!sidecar || sidecar.kind !== 'subtitle' || sidecar.downloadId !== found.file.downloadId) {
          return c.json({ error: 'Not found' }, 404);
        }
        // A sidecar is already text on disk; there is nothing for ffmpeg to do.
        const path = resolveWithin(config.LIBRARY_ROOT, sidecar.libraryPath);
        return c.body(await readFile(path, 'utf8'), 200, subtitleHeaders(extname(path)));
      }

      if (!track.startsWith('embedded-')) return c.json({ error: 'Not found' }, 404);
      const typeIndex = Number(track.slice('embedded-'.length));
      const probed = await probeFile(found.file);
      const stream = subtitleStreams(probed.info).find((s) => s.typeIndex === typeIndex);
      const format = stream && TEXT_SUBTITLE_CODECS[stream.codec];
      if (!format) return c.json({ error: 'No such subtitle track' }, 404);

      const text = await extractSubtitle(probed.path, typeIndex, format);
      return c.body(text, 200, subtitleHeaders(format === 'ass' ? '.ass' : '.vtt'));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  })

  /**
   * A font attached to the Matroska file. ASS typesetting is unreadable in the
   * wrong face, and these are the faces the release was made with.
   */
  .get('/:fileId/fonts/:index', async (c) => {
    const found = loadFile(Number(c.req.param('fileId')));
    if (!found) return c.json({ error: 'Not found' }, 404);

    const typeIndex = Number(c.req.param('index'));
    try {
      const probed = await probeFile(found.file);
      const stream = attachmentStreams(probed.info).find((s) => s.typeIndex === typeIndex);
      if (!stream) return c.json({ error: 'No such attachment' }, 404);

      const body = await extractAttachment(probed.path, typeIndex);
      return c.body(toArrayBuffer(body), 200, {
        'Content-Type': stream.mimetype ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400'
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 502);
    }
  })

  /** Save the resume point. Called every few seconds while playing. */
  .post('/:fileId/progress', async (c) => {
    const file = importedFiles.find(Number(c.req.param('fileId')));
    if (!file || file.kind !== 'video') return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      positionMs?: number;
      durationMs?: number;
      played?: boolean;
    };
    if (typeof body.positionMs !== 'number' || !Number.isFinite(body.positionMs)) {
      return c.json({ error: 'positionMs is required' }, 400);
    }

    const progress = playbackProgress.save({
      importedFileId: file.id,
      positionMs: body.positionMs,
      durationMs: body.durationMs,
      played: body.played
    });
    return c.json({ positionMs: progress.positionMs, played: progress.played });
  })

  /** Explicit "mark watched" / "mark unwatched" from the library list. */
  .post('/:fileId/played', async (c) => {
    const file = importedFiles.find(Number(c.req.param('fileId')));
    if (!file || file.kind !== 'video') return c.json({ error: 'Not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as { played?: boolean };
    playbackProgress.setPlayed(file.id, body.played !== false);
    return c.json({ ok: true });
  });

// --- helpers ---------------------------------------------------------------

interface Prepared {
  file: ImportedFile;
  path: string;
  plan: PlayPlan;
  segments: Segment[];
  capsRaw: string;
}

/**
 * Rebuild the plan and segment list for an HLS request.
 *
 * Every segment request goes through this rather than through shared session
 * state, so it has to be cheap: the probe and the keyframe scan are both
 * cached in the database, leaving a few object allocations.
 */
async function prepare(
  fileIdParam: string,
  query: Record<string, string>
): Promise<Prepared | { error: string; status: 404 | 502 }> {
  const found = loadFile(Number(fileIdParam));
  if (!found) return { error: 'Not found', status: 404 };

  const capsRaw = query.caps ?? '';
  const audioParam = query.audio;
  const audioTrack = audioParam === undefined ? undefined : Number(audioParam);

  try {
    const probed = await probeFile(found.file);
    const plan = decidePlayback(probed.info, parseCapabilities(capsRaw), {
      audioTrack: Number.isFinite(audioTrack) ? audioTrack : undefined,
      extension: extname(probed.path)
    });

    // Only a copy is constrained to source keyframes; when re-encoding we make
    // our own, so the expensive scan can be skipped entirely.
    const keyframes =
      plan.video?.action === 'copy' ? await keyframesFor(found.file, probed) : undefined;

    return {
      file: found.file,
      path: probed.path,
      plan,
      segments: segmentPlan(probed.info.durationMs, keyframes),
      capsRaw
    };
  } catch (error) {
    return { error: errorMessage(error), status: 502 };
  }
}

/** Hono wants an ArrayBuffer, and Buffer views may be windows into a pool. */
function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

function subtitleHeaders(extension: string): Record<string, string> {
  const type =
    extension === '.vtt'
      ? 'text/vtt; charset=utf-8'
      : extension === '.srt'
        ? 'application/x-subrip; charset=utf-8'
        : 'text/x-ssa; charset=utf-8';
  return { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' };
}
