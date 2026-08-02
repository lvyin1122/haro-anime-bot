import { constants } from 'node:fs';
import { access, link, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';

import { config } from '../config.ts';

/**
 * Rewrite a path from qBittorrent's filesystem namespace into ours.
 *
 * qBittorrent reports `content_path` as *its* container sees it. If both
 * containers mount the same host directory at the same path this is a no-op,
 * which is the arrangement to aim for — but they need not match, so the
 * QB_DOWNLOAD_ROOT → DOWNLOAD_ROOT prefix swap covers the general case.
 */
export function mapFromQbPath(qbPath: string): string {
  const from = config.QB_DOWNLOAD_ROOT.replace(/\/+$/, '');
  const to = config.DOWNLOAD_ROOT.replace(/\/+$/, '');

  if (from === to) return qbPath;
  if (qbPath === from) return to;
  if (qbPath.startsWith(`${from}/`)) return to + qbPath.slice(from.length);

  // Outside the mapped root: hand it back untouched and let the caller's
  // existence check produce a comprehensible error.
  return qbPath;
}

/** The inverse — a path of ours expressed the way qBittorrent would see it. */
export function mapToQbPath(localPath: string): string {
  const from = config.DOWNLOAD_ROOT.replace(/\/+$/, '');
  const to = config.QB_DOWNLOAD_ROOT.replace(/\/+$/, '');

  if (from === to) return localPath;
  if (localPath === from) return to;
  if (localPath.startsWith(`${from}/`)) return to + localPath.slice(from.length);
  return localPath;
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface HardlinkProbe {
  ok: boolean;
  downloadRootExists: boolean;
  libraryRootExists: boolean;
  sameDevice: boolean;
  writable: boolean;
  detail: string;
}

/**
 * Verify that the two roots exist, sit on one device, and that we can actually
 * create a hardlink between them. Hardlinks cannot cross filesystems, and
 * discovering that at first import — after a torrent has already downloaded —
 * is a much worse experience than failing the health check on boot.
 */
export async function probeHardlink(): Promise<HardlinkProbe> {
  const downloadRoot = config.DOWNLOAD_ROOT;
  const libraryRoot = config.LIBRARY_ROOT;

  const result: HardlinkProbe = {
    ok: false,
    downloadRootExists: await pathExists(downloadRoot),
    libraryRootExists: await pathExists(libraryRoot),
    sameDevice: false,
    writable: false,
    detail: ''
  };

  if (!result.downloadRootExists) {
    result.detail = `DOWNLOAD_ROOT does not exist inside the container: ${downloadRoot}. Check the volume mount.`;
    return result;
  }
  if (!result.libraryRootExists) {
    // Creating it is reasonable — the library may simply be empty so far.
    try {
      await mkdir(libraryRoot, { recursive: true });
      result.libraryRootExists = true;
    } catch (error) {
      result.detail = `LIBRARY_ROOT does not exist and could not be created: ${libraryRoot} (${(error as Error).message})`;
      return result;
    }
  }

  const [downloadStat, libraryStat] = await Promise.all([stat(downloadRoot), stat(libraryRoot)]);
  result.sameDevice = downloadStat.dev === libraryStat.dev;

  if (!result.sameDevice) {
    result.detail =
      `DOWNLOAD_ROOT and LIBRARY_ROOT are on different filesystems (dev ${downloadStat.dev} vs ${libraryStat.dev}). ` +
      `Hardlinks cannot cross devices — mount both from one host filesystem.`;
    return result;
  }

  // Round-trip an actual link; permissions and read-only mounts only show up here.
  const probeSource = join(downloadRoot, '.haro-linkprobe');
  const probeTarget = join(libraryRoot, '.haro-linkprobe');
  try {
    await writeFile(probeSource, 'haro');
    await rm(probeTarget, { force: true });
    await link(probeSource, probeTarget);
    result.writable = true;
    result.ok = true;
    result.detail = 'Hardlinks work between DOWNLOAD_ROOT and LIBRARY_ROOT.';
  } catch (error) {
    const message = (error as NodeJS.ErrnoException).code === 'EACCES'
      ? `Permission denied. Run the container as qBittorrent's PUID:PGID (see \`user:\` in docker-compose.yml).`
      : (error as Error).message;
    result.detail = `Hardlink probe failed: ${message}`;
  } finally {
    await rm(probeSource, { force: true }).catch(() => {});
    await rm(probeTarget, { force: true }).catch(() => {});
  }

  return result;
}

/** Create a hardlink, making parent directories as needed. */
export async function hardlink(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return; // already imported
    if (code === 'EXDEV') {
      throw new Error(
        `Cannot hardlink across filesystems: ${source} → ${target}. ` +
          `DOWNLOAD_ROOT and LIBRARY_ROOT must be on the same host filesystem.`
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `Permission denied creating ${target}. Run the container as qBittorrent's PUID:PGID.`
      );
    }
    throw error;
  }
}

/** Join path segments that may contain user-supplied folder names. */
export function libraryPath(...segments: string[]): string {
  return posix.join(config.LIBRARY_ROOT, ...segments);
}
