/**
 * Seed the dev stack with playable sample episodes.
 *
 *   docker compose -f docker-compose.dev.yml exec haro-dev \
 *     node --experimental-strip-types server/scripts/seed-dev.ts
 *
 * A fresh clone has an empty library, so there is nothing to click Play on and
 * no way to tell whether the player works. This synthesises three episodes with
 * ffmpeg, one for each playback path the player can take:
 *
 *   E01  MKV, H.264 8-bit + AAC      → remuxed (`-c copy` into fMP4 over HLS)
 *   E02  MKV, 10-bit + 2 audio + ASS → transcoded (no browser decodes 10-bit)
 *   E03  MP4, H.264 8-bit + AAC      → direct play, no ffmpeg at all
 *
 * They are written into DOWNLOAD_ROOT and hardlinked into LIBRARY_ROOT exactly
 * as a real import would, then recorded in the database, so everything
 * downstream — the Library list, resume state, the player — sees ordinary rows.
 *
 * Idempotent: re-running reports what already exists and changes nothing.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { config } from '../src/config.ts';
import { db } from '../src/db/index.ts';
import { downloads, importedFiles, subscriptions } from '../src/data.ts';
import { hardlink } from '../src/core/paths.ts';
import { episodeFileName, seasonFolderName, subtitleFileName } from '../src/core/naming.ts';

const TITLE = 'Haro Sample Anime';
const FOLDER = 'Haro Sample Anime (2026)';
const SEASON = 1;
const RELEASE_DIR = join(config.DOWNLOAD_ROOT, '[Haro Samples] Haro Sample Anime (2026)');
const DURATION = 30;
/** Bangumi subject 302286; only used so the row looks like a real subscription. */
const SUBJECT_ID = 302286;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code}\n${stderr.slice(-2000)}`))
    );
  });
}

/**
 * Encode with the first codec that works.
 *
 * `ffmpeg -encoders` lists codecs that cannot actually be instantiated — a
 * distribution's patent-free build advertises OpenH264 while shipping a stub,
 * and hardware encoders appear on machines with no usable device. The only
 * reliable test is to try, so this does, in preference order. The image Haro
 * ships succeeds on the first candidate every time; this exists so the seeder
 * also works on whatever ffmpeg a developer happens to have.
 */
async function encodeWithFallback(
  candidates: string[][],
  args: (codec: string[]) => string[]
): Promise<void> {
  let last: unknown;
  for (const codec of candidates) {
    try {
      await run('ffmpeg', args(codec));
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error('no usable video encoder');
}

const source = (n: number) => [
  '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${DURATION}`,
  '-f', 'lavfi', '-i', `sine=frequency=${n}:duration=${DURATION}`
];

const SAMPLE_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Sans,48,&H00FFFFFF,&H00000000,&H80000000,0,2,1,2,20,20,40,1
Style: Sign,Sans,64,&H0040E0D0,&H00000000,&H80000000,1,3,0,8,20,20,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:08.00,Default,,0,0,0,,This line is rendered by libass, not by the browser.
Dialogue: 0,0:00:08.00,0:00:16.00,Sign,,0,0,0,,{\\an8}Styled sign — top-aligned, coloured, outlined
Dialogue: 0,0:00:16.00,0:00:24.00,Default,,0,0,0,,{\\fad(400,400)}Fades, positioning and karaoke all come from the ASS track.
Dialogue: 0,0:00:24.00,0:00:30.00,Default,,0,0,0,,字幕渲染正常 — CJK renders too.
`;

/** 8-bit H.264, or the closest thing this ffmpeg can produce. */
const EIGHT_BIT: string[][] = [
  ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'ultrafast'],
  ['-c:v', 'libopenh264', '-profile:v', 'high', '-b:v', '1M'],
  ['-c:v', 'libvpx-vp9', '-b:v', '800k', '-speed', '8']
];

/** Something no browser decodes. 10-bit is the property that matters. */
const TEN_BIT: string[][] = [
  ['-c:v', 'libx265', '-x265-params', 'log-level=error', '-preset', 'ultrafast'],
  ['-c:v', 'libx264', '-profile:v', 'high10', '-preset', 'ultrafast'],
  ['-c:v', 'libvpx-vp9', '-b:v', '800k', '-speed', '8']
];

/** E01 — the common fansub shape: Matroska wrapping browser-safe streams. */
async function buildRemuxSample(target: string): Promise<void> {
  await encodeWithFallback(EIGHT_BIT, (codec) => [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...source(440),
    ...codec, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:0', 'title=Japanese',
    target
  ]);
}

/** E02 — 10-bit, multi-audio, embedded ASS. Nothing here direct-plays. */
async function buildTranscodeSample(target: string, assPath: string): Promise<void> {
  await encodeWithFallback(TEN_BIT, (codec) => [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...source(440),
    '-f', 'lavfi', '-i', `sine=frequency=660:duration=${DURATION}`,
    '-i', assPath,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    ...codec, '-pix_fmt', 'yuv420p10le',
    '-c:a', 'aac', '-b:a', '128k',
    '-c:s', 'copy',
    '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:0', 'title=Japanese',
    '-metadata:s:a:1', 'language=eng', '-metadata:s:a:1', 'title=English dub',
    '-metadata:s:s:0', 'language=chi', '-metadata:s:s:0', 'title=简体中文',
    target
  ]);
}

/** E03 — already an MP4 of browser-safe streams, so ffmpeg never runs. */
async function buildDirectSample(target: string): Promise<void> {
  await encodeWithFallback(EIGHT_BIT, (codec) => [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...source(880),
    ...codec, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    target
  ]);
}

interface Sample {
  episode: number;
  releaseName: string;
  extension: string;
  build: (target: string) => Promise<void>;
  /** Sidecar subtitle written next to the release, imported alongside it. */
  sidecar?: boolean;
}

const SAMPLES: Sample[] = [
  {
    episode: 1,
    releaseName: '[Haro Samples] Haro Sample Anime - 01 [1080p H264 AAC]',
    extension: '.mkv',
    build: buildRemuxSample,
    sidecar: true
  },
  {
    episode: 2,
    releaseName: '[Haro Samples] Haro Sample Anime - 02 [1080p HEVC-10bit AAC]',
    extension: '.mkv',
    build: (target) => buildTranscodeSample(target, join(RELEASE_DIR, 'sample.ass'))
  },
  {
    episode: 3,
    releaseName: '[Haro Samples] Haro Sample Anime - 03 [1080p H264 AAC]',
    extension: '.mp4',
    build: buildDirectSample
  }
];

async function main(): Promise<void> {
  if (config.NODE_ENV === 'production') {
    console.error('Refusing to seed sample media into a production instance.');
    process.exit(1);
  }

  db(); // migrations, before any query

  const existing = subscriptions.list().find((s) => s.title === TITLE);
  if (existing) {
    // A run that failed partway leaves the subscription behind with nothing
    // under it, and reporting that as "already seeded" would strand the stack
    // with an empty library and no obvious way forward.
    const complete = downloads
      .list({ subscriptionId: existing.id, status: ['imported'] })
      .length >= SAMPLES.length;
    if (complete) {
      console.log(`Sample subscription #${existing.id} already exists — nothing to do.`);
      return;
    }
    console.log(`Clearing an incomplete sample subscription #${existing.id} and starting over.`);
    subscriptions.remove(existing.id);
  }

  console.log(`Generating ${SAMPLES.length} sample episodes with ffmpeg (~${DURATION}s each)…`);
  await mkdir(RELEASE_DIR, { recursive: true });

  const assPath = join(RELEASE_DIR, 'sample.ass');
  await writeFile(assPath, SAMPLE_ASS, 'utf8');

  const subscription = subscriptions.create({
    subjectId: SUBJECT_ID,
    title: TITLE,
    season: SEASON,
    episodeOffset: 0,
    filter: { fansubs: ['Haro Samples'], include: [], exclude: [] },
    libraryFolder: FOLDER,
    enabled: false, // never let the poller chase a series that does not exist
    autoDownload: false
  });

  const seasonDir = join(config.LIBRARY_ROOT, FOLDER, seasonFolderName(SEASON));
  await mkdir(seasonDir, { recursive: true });

  for (const sample of SAMPLES) {
    const sourcePath = join(RELEASE_DIR, sample.releaseName + sample.extension);
    if (!existsSync(sourcePath)) await sample.build(sourcePath);

    const libraryPath = join(
      seasonDir,
      episodeFileName(TITLE, SEASON, sample.episode, sample.extension)
    );
    await hardlink(sourcePath, libraryPath);

    const now = Date.now();
    const download = downloads.create({
      subscriptionId: subscription.id,
      title: sample.releaseName,
      magnet: `magnet:?xt=urn:btih:${'0'.repeat(31)}${sample.episode}`,
      infoHash: `${'0'.repeat(39)}${sample.episode}`,
      size: (await stat(sourcePath)).size,
      fansub: 'Haro Samples',
      season: SEASON,
      episode: sample.episode,
      status: 'imported',
      contentPath: sourcePath,
      addedAt: now,
      completedAt: now,
      provider: 'sample'
    });
    downloads.update(download.id, { importedAt: now, qbProgress: 1 });

    importedFiles.record({
      downloadId: download.id,
      sourcePath,
      libraryPath,
      episode: sample.episode,
      kind: 'video'
    });

    if (sample.sidecar) {
      // Exercises the sidecar-subtitle path, which is separate from the
      // embedded-track path E02 covers.
      const sidecarSource = join(RELEASE_DIR, `${sample.releaseName}.zh-Hans.ass`);
      await writeFile(sidecarSource, SAMPLE_ASS, 'utf8');
      const sidecarTarget = join(
        seasonDir,
        subtitleFileName(TITLE, SEASON, sample.episode, '.ass', ['简'])
      );
      await hardlink(sidecarSource, sidecarTarget);
      importedFiles.record({
        downloadId: download.id,
        sourcePath: sidecarSource,
        libraryPath: sidecarTarget,
        episode: sample.episode,
        kind: 'subtitle'
      });
    }

    console.log(`  ✓ E0${sample.episode}  ${libraryPath}`);
  }

  await rm(assPath, { force: true });
  console.log(`\nSeeded subscription #${subscription.id}. Open the Library tab and press Play.`);
}

try {
  await main();
} catch (error) {
  // Leave nothing half-built: a stale subscription with no episodes under it
  // would make the next run think the work was already done.
  const partial = subscriptions.list().find((s) => s.title === TITLE);
  if (partial) subscriptions.remove(partial.id);
  console.error(`\nSeeding failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
