import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { getSubject, mainEpisodes, subjectYear } from '../clients/bangumi.ts';
import { invalidateSeriesCache, scheduleLibraryRefresh } from '../clients/jellyfin.ts';
import { listFiles } from '../clients/qbittorrent.ts';
import { config } from '../config.ts';
import { downloads, importedFiles, type Download, type Subscription } from '../data.ts';
import { errorMessage, log } from '../log.ts';
import { buildEpisodeNfo, buildTvShowNfo, findEpisode } from './nfo.ts';
import {
  applyOffset,
  episodeFileName,
  isSubtitle,
  isVideo,
  parseRelease,
  seasonFolderName,
  subtitleFileName
} from './naming.ts';
import { hardlink, mapFromQbPath, pathExists } from './paths.ts';

interface Candidate {
  sourcePath: string;
  episode: number;
  lowConfidence: boolean;
}

/** Every file under a directory, recursively, as absolute paths. */
async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * Resolve a completed torrent to the actual files on our side of the mount.
 *
 * qBittorrent's `content_path` is a single file for single-file torrents and
 * the containing directory for multi-file ones, expressed in its own
 * namespace — hence the mapping before anything touches the filesystem.
 */
async function resolveSourceFiles(download: Download): Promise<string[]> {
  const contentPath = download.contentPath ? mapFromQbPath(download.contentPath) : undefined;

  if (contentPath && (await pathExists(contentPath))) {
    const info = await stat(contentPath);
    return info.isDirectory() ? walk(contentPath) : [contentPath];
  }

  // Fall back to asking qBittorrent for the file list and rebuilding paths
  // beneath DOWNLOAD_ROOT — covers a content_path we could not map.
  const files = await listFiles(download.infoHash).catch(() => []);
  const rebuilt: string[] = [];
  for (const file of files) {
    const candidate = join(config.DOWNLOAD_ROOT, file.name);
    if (await pathExists(candidate)) rebuilt.push(candidate);
  }

  if (rebuilt.length === 0) {
    throw new Error(
      `Cannot locate downloaded files. qBittorrent reports "${download.contentPath ?? '(none)'}"; ` +
        `mapped to "${contentPath ?? '(unmapped)'}" which does not exist. ` +
        `Check that DOWNLOAD_ROOT and QB_DOWNLOAD_ROOT describe the same directory.`
    );
  }
  return rebuilt;
}

/**
 * Decide which episode each video file belongs to.
 *
 * A single-file torrent inherits the episode parsed from its release title —
 * the filename inside a release is often less informative than the title. A
 * batch torrent has to be split per file, since one torrent then produces a
 * whole season.
 */
function assignEpisodes(
  videos: string[],
  download: Download,
  subscription: Subscription
): Candidate[] {
  if (videos.length === 1 && download.episode !== undefined) {
    return [
      {
        sourcePath: videos[0]!,
        episode: applyOffset(download.episode, subscription.episodeOffset),
        lowConfidence: download.needsReview
      }
    ];
  }

  const candidates: Candidate[] = [];
  for (const video of videos) {
    const parsed = parseRelease(basename(video));
    if (parsed.episode === undefined) {
      log.warn('importer', `no episode number in "${basename(video)}", skipping`, {
        downloadId: download.id
      });
      continue;
    }
    candidates.push({
      sourcePath: video,
      episode: applyOffset(parsed.episode, subscription.episodeOffset),
      lowConfidence: parsed.lowConfidence
    });
  }
  return candidates;
}

/** Sidecar subtitles sitting next to a video, matched on filename stem. */
function subtitlesFor(videoPath: string, allFiles: string[]): string[] {
  const stem = basename(videoPath, extname(videoPath));
  const folder = dirname(videoPath);
  return allFiles.filter(
    (file) => isSubtitle(file) && dirname(file) === folder && basename(file).startsWith(stem)
  );
}

async function writeSeriesMetadata(
  subscription: Subscription,
  seriesDir: string,
  downloadId: number
): Promise<void> {
  const subject = await getSubject(subscription.subjectId).catch(() => undefined);
  if (!subject) {
    log.warn('importer', 'no Bangumi data available; skipping tvshow.nfo', {
      subjectId: subscription.subjectId
    });
    return;
  }

  const nfoPath = join(seriesDir, 'tvshow.nfo');
  await writeFile(nfoPath, buildTvShowNfo({ subject, title: subscription.title }), 'utf8');
  importedFiles.record({
    downloadId,
    sourcePath: `bangumi:${subject.id}`,
    libraryPath: nfoPath,
    kind: 'metadata'
  });

  // Cover art, fetched once and then left alone so later episodes do not
  // re-download it. Only poster.jpg: Bangumi serves a portrait cover and no
  // backdrop, and reusing the cover as fanart.jpg gives Jellyfin a
  // wrong-aspect background rather than no background.
  const posterUrl = subject.images?.large ?? subject.images?.common;
  const posterPath = join(seriesDir, 'poster.jpg');

  if (posterUrl && !(await pathExists(posterPath))) {
    try {
      const response = await fetch(posterUrl, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        await writeFile(posterPath, Buffer.from(await response.arrayBuffer()));
        importedFiles.record({
          downloadId,
          sourcePath: posterUrl,
          libraryPath: posterPath,
          kind: 'artwork'
        });
      }
    } catch (error) {
      log.warn('importer', 'could not fetch poster.jpg', { error: errorMessage(error) });
    }
  }
}

export interface ImportResult {
  imported: number;
  skipped: number;
  paths: string[];
}

/**
 * Hardlink a completed download into the Jellyfin library and write its
 * metadata. Hardlinks mean qBittorrent keeps seeding the original file while
 * Jellyfin sees a correctly named one, at zero extra disk cost.
 */
export async function importDownload(
  download: Download,
  subscription: Subscription
): Promise<ImportResult> {
  const files = await resolveSourceFiles(download);
  const videos = files.filter((f) => isVideo(f));

  if (videos.length === 0) {
    throw new Error(
      `No video files found in the completed torrent (${files.length} file(s) present).`
    );
  }

  const seriesDir = join(config.LIBRARY_ROOT, subscription.libraryFolder);
  const subject = await getSubject(subscription.subjectId).catch(() => undefined);
  const episodeList = subject ? mainEpisodes(subject) : [];

  const candidates = assignEpisodes(videos, download, subscription);
  if (candidates.length === 0) {
    throw new Error('Could not determine an episode number for any file in this torrent.');
  }

  const written: string[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const seasonDir = join(seriesDir, seasonFolderName(subscription.season));
    const extension = extname(candidate.sourcePath);
    const target = join(
      seasonDir,
      episodeFileName(subscription.title, subscription.season, candidate.episode, extension)
    );

    if (await pathExists(target)) {
      skipped++;
      continue;
    }

    await hardlink(candidate.sourcePath, target);
    written.push(target);
    importedFiles.record({
      downloadId: download.id,
      sourcePath: candidate.sourcePath,
      libraryPath: target,
      episode: candidate.episode,
      kind: 'video'
    });

    // Episode NFO, from Bangumi where available.
    const nfoPath = target.replace(new RegExp(`${escapeRegExp(extension)}$`), '.nfo');
    await writeFile(
      nfoPath,
      buildEpisodeNfo({
        episode: findEpisode(episodeList, candidate.episode),
        season: subscription.season,
        episodeNumber: candidate.episode,
        fallbackTitle: `Episode ${Math.floor(candidate.episode)}`
      }),
      'utf8'
    );
    importedFiles.record({
      downloadId: download.id,
      sourcePath: candidate.sourcePath,
      libraryPath: nfoPath,
      episode: candidate.episode,
      kind: 'metadata'
    });

    // External subtitle tracks.
    const parsed = parseRelease(download.title);
    for (const subtitle of subtitlesFor(candidate.sourcePath, files)) {
      const subtitleTarget = join(
        seasonDir,
        subtitleFileName(
          subscription.title,
          subscription.season,
          candidate.episode,
          extname(subtitle),
          parsed.subtitleLanguages
        )
      );
      if (await pathExists(subtitleTarget)) continue;
      await hardlink(subtitle, subtitleTarget);
      written.push(subtitleTarget);
      importedFiles.record({
        downloadId: download.id,
        sourcePath: subtitle,
        libraryPath: subtitleTarget,
        episode: candidate.episode,
        kind: 'subtitle'
      });
    }
  }

  if (written.length > 0) {
    await writeSeriesMetadata(subscription, seriesDir, download.id);
    // A first-ever import creates the series in Jellyfin, so a cached "not
    // found" from before the scan must not stick around.
    invalidateSeriesCache();
    scheduleLibraryRefresh();
  }

  // The claim index keys off a single episode; for a batch, the first is
  // representative and the rest are recorded in imported_files.
  const primary = candidates[0]!;
  downloads.update(download.id, {
    status: 'imported',
    episode: primary.episode,
    season: subscription.season,
    importedAt: Date.now(),
    error: undefined
  });

  log.info(
    'importer',
    `imported ${written.length} file(s) for "${subscription.title}"${skipped ? ` (${skipped} already present)` : ''}`,
    { downloadId: download.id, episodes: candidates.map((c) => c.episode) }
  );

  return { imported: written.length, skipped, paths: written };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
