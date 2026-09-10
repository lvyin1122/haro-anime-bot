import { Hono } from 'hono';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config.ts';
import { downloads, importedFiles, playbackProgress, subscriptions } from '../src/data.ts';
import { db } from '../src/db/index.ts';
import { resolveWithin } from '../src/core/paths.ts';
import { playRoutes } from '../src/routes/play.ts';

const app = new Hono().route('/api/play', playRoutes);

/** An imported episode, on disk and in the database, as the importer leaves it. */
async function importEpisode(options: { name: string; libraryPath?: string } ) {
  const subscription = subscriptions.create({
    subjectId: Math.floor(Math.random() * 1e6),
    title: options.name,
    season: 1,
    episodeOffset: 0,
    filter: {},
    libraryFolder: options.name,
    enabled: false,
    autoDownload: false
  });

  const infoHash = Math.random().toString(16).slice(2).padEnd(40, '0').slice(0, 40);
  const download = downloads.create({
    subscriptionId: subscription.id,
    title: `[Test] ${options.name} - 01`,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
    infoHash,
    season: 1,
    episode: 1,
    status: 'imported',
    addedAt: Date.now()
  });

  const libraryPath =
    options.libraryPath ?? join(config.LIBRARY_ROOT, options.name, 'Season 01', 'ep.mkv');
  await mkdir(join(config.LIBRARY_ROOT, options.name, 'Season 01'), { recursive: true });
  importedFiles.record({
    downloadId: download.id,
    sourcePath: '/downloads/complete/x.mkv',
    libraryPath,
    episode: 1,
    kind: 'video'
  });

  return { subscription, download, file: importedFiles.videosFor(download.id)[0]! };
}

beforeEach(() => {
  db(); // migrations; the test database is :memory: and rebuilt per process
});

describe('GET /api/play/:fileId/info', () => {
  it('404s on an id that is not an imported file', async () => {
    const response = await app.request('/api/play/999999/info');
    expect(response.status).toBe(404);
  });

  it('404s on a file that exists but is not a video', async () => {
    const { download } = await importEpisode({ name: 'Subtitle Only' });
    importedFiles.record({
      downloadId: download.id,
      sourcePath: '/downloads/complete/x.ass',
      libraryPath: join(config.LIBRARY_ROOT, 'Subtitle Only', 'Season 01', 'ep.zh-Hans.ass'),
      episode: 1,
      kind: 'subtitle'
    });
    const subtitle = importedFiles.subtitlesFor(download.id, 1)[0]!;

    const response = await app.request(`/api/play/${subtitle.id}/info`);
    expect(response.status).toBe(404);
  });

  it('reports a probe failure as a bad gateway rather than crashing the request', async () => {
    // The row points at a path that was never written, so ffprobe (or the
    // stat before it) fails — the shape a deleted file arrives in.
    const { file } = await importEpisode({ name: 'Missing File' });
    const response = await app.request(`/api/play/${file.id}/info`);

    expect(response.status).toBe(502);
    expect(await response.json()).toHaveProperty('error');
  });
});

describe('path containment', () => {
  it('refuses a library_path that escapes LIBRARY_ROOT', async () => {
    const { file } = await importEpisode({
      name: 'Escaping Row',
      libraryPath: join(config.LIBRARY_ROOT, '..', '..', 'etc', 'passwd')
    });

    const response = await app.request(`/api/play/${file.id}/info`);
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/escapes/i);
  });

  it('resolveWithin accepts paths inside the root and rejects the rest', () => {
    const root = '/media/anime';
    expect(resolveWithin(root, '/media/anime/Show/ep.mkv')).toBe('/media/anime/Show/ep.mkv');
    expect(resolveWithin(root, '/media/anime')).toBe('/media/anime');
    expect(resolveWithin(root, 'Show/ep.mkv')).toBe('/media/anime/Show/ep.mkv');

    expect(() => resolveWithin(root, '/media/anime/../secrets')).toThrow(/escapes/);
    expect(() => resolveWithin(root, '../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveWithin(root, '/etc/passwd')).toThrow(/escapes/);
    // A sibling directory sharing the root's name prefix must not pass.
    expect(() => resolveWithin(root, '/media/anime-private/x')).toThrow(/escapes/);
  });
});

describe('POST /api/play/:fileId/progress', () => {
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

  it('stores a resume position', async () => {
    const { file } = await importEpisode({ name: 'Resume Me' });

    const response = await post(`/api/play/${file.id}/progress`, {
      positionMs: 61_000,
      durationMs: 1_440_000
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ positionMs: 61_000, played: false });
    expect(playbackProgress.find(file.id)?.positionMs).toBe(61_000);
  });

  it('marks an episode watched once it is near the end', async () => {
    const { file } = await importEpisode({ name: 'Nearly Done' });

    const response = await post(`/api/play/${file.id}/progress`, {
      positionMs: 1_400_000,
      durationMs: 1_440_000
    });
    expect(await response.json()).toMatchObject({ played: true });
  });

  it('keeps an episode watched when you start it again', async () => {
    const { file } = await importEpisode({ name: 'Rewatch' });

    await post(`/api/play/${file.id}/progress`, { positionMs: 1_400_000, durationMs: 1_440_000 });
    await post(`/api/play/${file.id}/progress`, { positionMs: 5_000, durationMs: 1_440_000 });

    const saved = playbackProgress.find(file.id)!;
    expect(saved.played).toBe(true);
    expect(saved.positionMs).toBe(5_000);
  });

  it('rejects a body without a position', async () => {
    const { file } = await importEpisode({ name: 'No Position' });
    expect((await post(`/api/play/${file.id}/progress`, { durationMs: 10 })).status).toBe(400);
  });

  it('clears the resume point when an episode is marked unwatched', async () => {
    const { file } = await importEpisode({ name: 'Unwatch' });

    await post(`/api/play/${file.id}/progress`, { positionMs: 1_400_000, durationMs: 1_440_000 });
    await post(`/api/play/${file.id}/played`, { played: false });

    const saved = playbackProgress.find(file.id)!;
    expect(saved.played).toBe(false);
    expect(saved.positionMs).toBe(0);
  });
});

describe('subtitle tracks', () => {
  it('serves a sidecar subtitle straight off disk', async () => {
    const { download, file } = await importEpisode({ name: 'With Sidecar' });
    const sidecarPath = join(config.LIBRARY_ROOT, 'With Sidecar', 'Season 01', 'ep.zh-Hans.ass');
    await writeFile(sidecarPath, '[Script Info]\nScriptType: v4.00+\n', 'utf8');
    importedFiles.record({
      downloadId: download.id,
      sourcePath: '/downloads/complete/x.ass',
      libraryPath: sidecarPath,
      episode: 1,
      kind: 'subtitle'
    });
    const sidecar = importedFiles.subtitlesFor(download.id, 1)[0]!;

    const response = await app.request(`/api/play/${file.id}/subtitles/sidecar-${sidecar.id}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/ssa|ass/);
    expect(await response.text()).toContain('[Script Info]');
  });

  it('refuses a sidecar belonging to a different download', async () => {
    const { file } = await importEpisode({ name: 'Owner' });
    const other = await importEpisode({ name: 'Stranger' });
    importedFiles.record({
      downloadId: other.download.id,
      sourcePath: '/downloads/complete/y.ass',
      libraryPath: join(config.LIBRARY_ROOT, 'Stranger', 'Season 01', 'ep.zh-Hans.ass'),
      episode: 1,
      kind: 'subtitle'
    });
    const strangerSidecar = importedFiles.subtitlesFor(other.download.id, 1)[0]!;

    const response = await app.request(
      `/api/play/${file.id}/subtitles/sidecar-${strangerSidecar.id}`
    );
    expect(response.status).toBe(404);
  });
});
