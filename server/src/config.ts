import { z } from 'zod';

const trimmed = z.string().transform((s) => s.trim());

const url = trimmed.refine((s) => /^https?:\/\//.test(s), {
  message: 'must start with http:// or https://'
});

// Trailing slashes make every downstream `${base}/path` join produce a double
// slash, which qBittorrent's CSRF check in particular does not forgive.
const baseUrl = url.transform((s) => s.replace(/\/+$/, ''));

const absPath = trimmed.refine((s) => s.startsWith('/'), {
  message: 'must be an absolute path'
});

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(7802),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  WEB_ROOT: trimmed.optional(),

  DATA_DIR: absPath.default('/config'),
  DOWNLOAD_ROOT: absPath.default('/downloads/complete'),
  LIBRARY_ROOT: absPath.default('/media/anime'),
  QB_DOWNLOAD_ROOT: absPath.default('/downloads/complete'),

  QBITTORRENT_URL: baseUrl.default('http://host.docker.internal:8080'),
  QBITTORRENT_USERNAME: trimmed.default('admin'),
  QBITTORRENT_PASSWORD: z.string().default(''),
  QBITTORRENT_CATEGORY: trimmed.default('haro-anime'),

  /**
   * Where "Play" sends you.
   *
   * `builtin` uses Haro's own player: ffmpeg repackages (or, for codecs the
   * browser cannot decode, re-encodes) on the fly and watched state is stored
   * locally. `jellyfin` deep-links into the Jellyfin web client and reads
   * watched state back from it. `auto` picks jellyfin when it is configured.
   */
  PLAYER_MODE: z.enum(['auto', 'builtin', 'jellyfin']).default('auto'),

  JELLYFIN_URL: baseUrl.default('http://host.docker.internal:8096'),
  JELLYFIN_API_KEY: z.string().default(''),
  JELLYFIN_USER_ID: z.string().default(''),
  /**
   * Browser-facing Jellyfin address, used to build "play" links.
   *
   * JELLYFIN_URL is how *this container* reaches Jellyfin — typically
   * host.docker.internal, which no browser on another machine can resolve.
   * Leave this empty and the UI falls back to the hostname you loaded Haro
   * from, on port 8096, which is right whenever both run on the same box.
   */
  JELLYFIN_PUBLIC_URL: z
    .union([z.literal(''), baseUrl])
    .default('')
    .transform((value) => value || undefined),

  ANIMEGARDEN_API: baseUrl.default('https://api.animes.garden'),
  BANGUMI_API: baseUrl.default('https://api.bgm.tv'),
  BANGUMI_USER_AGENT: trimmed.default('haro-anime-bot/0.1 (self-hosted)'),

  POLL_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(15),
  MONITOR_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),

  TZ: trimmed.default('Asia/Shanghai')
});

export type Config = z.infer<typeof ConfigSchema>;

function load(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${detail}`);
  }
  return parsed.data;
}

export const config = load();

/** `PLAYER_MODE` with `auto` resolved against whether Jellyfin is configured. */
export function playerMode(c: Config = config): 'builtin' | 'jellyfin' {
  if (c.PLAYER_MODE !== 'auto') return c.PLAYER_MODE;
  return c.JELLYFIN_API_KEY && c.JELLYFIN_USER_ID ? 'jellyfin' : 'builtin';
}

/** Whether Jellyfin has enough configuration to be talked to at all. */
export function jellyfinConfigured(c: Config = config): boolean {
  return Boolean(c.JELLYFIN_API_KEY && c.JELLYFIN_USER_ID);
}

/**
 * Warnings worth surfacing at boot and on the settings page. These are all
 * survivable — the app starts and the UI explains what is unconfigured —
 * rather than crash-on-boot, which would leave no way to fix them.
 */
export function configWarnings(c: Config = config): string[] {
  const warnings: string[] = [];
  if (!c.QBITTORRENT_PASSWORD) {
    warnings.push('QBITTORRENT_PASSWORD is empty — downloads will fail to enqueue.');
  }
  if (playerMode(c) === 'jellyfin' && !c.JELLYFIN_API_KEY) {
    warnings.push(
      'PLAYER_MODE is jellyfin but JELLYFIN_API_KEY is empty — set it, or use PLAYER_MODE=builtin.'
    );
  }
  if (c.DOWNLOAD_ROOT === c.LIBRARY_ROOT) {
    warnings.push(
      'DOWNLOAD_ROOT and LIBRARY_ROOT are the same path — imports would collide with the seeding files.'
    );
  }
  return warnings;
}
