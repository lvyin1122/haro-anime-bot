import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config.ts';
import { hardlink, mapFromQbPath, mapToQbPath, probeHardlink } from '../src/core/paths.ts';

describe('qBittorrent path mapping', () => {
  // setup.ts sets QB_DOWNLOAD_ROOT=/downloads/complete and DOWNLOAD_ROOT to a
  // temp dir, so these two namespaces genuinely differ.
  it('rewrites a qBittorrent path into ours', () => {
    expect(mapFromQbPath('/downloads/complete/Show/ep.mkv')).toBe(
      `${config.DOWNLOAD_ROOT}/Show/ep.mkv`
    );
  });

  it('rewrites the root itself', () => {
    expect(mapFromQbPath('/downloads/complete')).toBe(config.DOWNLOAD_ROOT);
  });

  it('round-trips', () => {
    const qbPath = '/downloads/complete/Show/ep.mkv';
    expect(mapToQbPath(mapFromQbPath(qbPath))).toBe(qbPath);
  });

  it('leaves unrelated paths untouched so errors stay comprehensible', () => {
    expect(mapFromQbPath('/somewhere/else/ep.mkv')).toBe('/somewhere/else/ep.mkv');
  });

  it('does not match a prefix that is only a partial path segment', () => {
    // "/downloads/completed" must not be treated as inside "/downloads/complete".
    expect(mapFromQbPath('/downloads/completed/x.mkv')).toBe('/downloads/completed/x.mkv');
  });
});

describe('hardlink', () => {
  const dir = () => join(config.DOWNLOAD_ROOT, 'linktest');
  const target = () => join(config.LIBRARY_ROOT, 'linktest');

  beforeEach(async () => {
    await mkdir(dir(), { recursive: true });
    await mkdir(target(), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir(), { recursive: true, force: true });
    await rm(target(), { recursive: true, force: true });
  });

  it('creates a link sharing the source inode', async () => {
    const source = join(dir(), 'source.mkv');
    const destination = join(target(), 'Show S01E01.mkv');
    await writeFile(source, 'video');

    await hardlink(source, destination);

    const [a, b] = await Promise.all([stat(source), stat(destination)]);
    // Same inode and a link count of 2 is what makes this zero-cost and keeps
    // qBittorrent seeding the original.
    expect(b.ino).toBe(a.ino);
    expect(b.nlink).toBe(2);
    expect(await readFile(destination, 'utf8')).toBe('video');
  });

  it('creates missing parent directories', async () => {
    const source = join(dir(), 'source.mkv');
    const destination = join(target(), 'Show (2026)', 'Season 01', 'Show S01E01.mkv');
    await writeFile(source, 'video');

    await hardlink(source, destination);
    expect((await stat(destination)).nlink).toBe(2);
  });

  it('is idempotent when the link already exists', async () => {
    const source = join(dir(), 'source.mkv');
    const destination = join(target(), 'Show S01E01.mkv');
    await writeFile(source, 'video');

    await hardlink(source, destination);
    // A re-import must not blow up on an episode already in the library.
    await expect(hardlink(source, destination)).resolves.toBeUndefined();
  });

  it('reports a missing source clearly', async () => {
    await expect(
      hardlink(join(dir(), 'missing.mkv'), join(target(), 'x.mkv'))
    ).rejects.toThrow();
  });
});

describe('probeHardlink', () => {
  it('passes when both roots share a filesystem', async () => {
    const result = await probeHardlink();
    expect(result.downloadRootExists).toBe(true);
    expect(result.libraryRootExists).toBe(true);
    expect(result.sameDevice).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('cleans up after itself', async () => {
    await probeHardlink();
    await expect(stat(join(config.DOWNLOAD_ROOT, '.haro-linkprobe'))).rejects.toThrow();
    await expect(stat(join(config.LIBRARY_ROOT, '.haro-linkprobe'))).rejects.toThrow();
  });
});
