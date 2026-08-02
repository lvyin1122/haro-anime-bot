import { parse as aniparParse } from 'anipar';

export interface ParsedRelease {
  /** Season from the title, when the release states one. */
  season?: number;
  /** Episode number, or the first episode of a batch. */
  episode?: number;
  /** Last episode of a batch release (01-24 → episodeTo = 24). */
  episodeTo?: number;
  fansub?: string;
  resolution?: string;
  subtitleLanguages?: string[];
  source?: string;
  extension?: string;
  /** True when the number came from the fallback matcher, not anipar. */
  lowConfidence: boolean;
}

// Numbers that look like episodes but are not — checked against the text
// immediately following a candidate match. A trailing "v2" is deliberately
// NOT here: "EP27 v2" is episode 27, release version 2.
const NOT_EPISODE_SUFFIX = /^\s*(?:p|P|i|bit|fps|kHz|Hz|年|月|話|集|x\d|人)/;

// Optional release-version suffix, with or without a space: "27v2", "27 v2".
const VERSION_SUFFIX = String.raw`(?:\s*[vV]\d)?`;

// Ordered most- to least-specific. Each must expose a capture group `ep`.
const FALLBACK_PATTERNS: RegExp[] = [
  // "第27话" / "第27集"
  /第\s*(?<ep>\d{1,4})\s*[话話集]/,
  // "- EP27", "EP 27", "E27" preceded by a separator
  new RegExp(String.raw`(?:^|[\s\-[(_])(?:EP?|ep?)\s*(?<ep>\d{1,4})${VERSION_SUFFIX}(?![\dp])`),
  // "S01E27"
  /S\d{1,2}E(?<ep>\d{1,4})/i,
  // " - 27 " with whitespace-dash-whitespace, the dominant fansub convention
  new RegExp(String.raw`\s-\s*(?<ep>\d{1,4})${VERSION_SUFFIX}(?:\s|$|\[|\()`),
  // "[27]" as a standalone bracket group
  new RegExp(String.raw`\[(?<ep>\d{1,3})${VERSION_SUFFIX}\]`)
];

const BATCH_PATTERNS: RegExp[] = [
  // "01-24", "01~24", "[01-12]"
  /(?:^|[\s[(|])(?<from>\d{1,3})\s*[-~－]\s*(?<to>\d{1,3})(?:\s|$|\]|\)|\[|\|)/
];

// Codec/audio markers whose parameters look exactly like episode ranges —
// "[Flac 16-44]" is a bit depth and sample rate, not episodes 16 through 44.
const TECHNICAL_PREFIX = /(?:flac|aac|opus|dts|ac3|eac3|mp3|wav|pcm|bit|hz|khz|x26\d|av1|hevc|avc|h\.?26\d)[\s\-_]*$/i;

/**
 * Upper bound on an episode number. Long-runners are real — One Piece is past
 * 1100 — so this has to be generous, but it must still reject the 6- and
 * 8-digit dates that litter release titles. A music release titled
 * "[Hi-Res][260116][葬送的芙莉莲]…" otherwise parses as episode 260116.
 */
const MAX_EPISODE = 9999;

function isPlausibleEpisode(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_EPISODE;
}

function fallbackEpisode(title: string): { episode?: number; episodeTo?: number } {
  for (const pattern of BATCH_PATTERNS) {
    const match = pattern.exec(title);
    if (!match) continue;

    const from = Number(match.groups?.from);
    const to = Number(match.groups?.to);

    // Guard against resolutions and year spans ("1920-1080", "2024-2025").
    if (!isPlausibleEpisode(from) || !isPlausibleEpisode(to)) continue;
    if (to <= from || to - from > 200) continue;
    // ...and against audio/codec parameters that share the same shape.
    if (TECHNICAL_PREFIX.test(title.slice(0, match.index + match[0].indexOf(match.groups!.from!))))
      continue;

    return { episode: from, episodeTo: to };
  }

  for (const pattern of FALLBACK_PATTERNS) {
    const match = pattern.exec(title);
    if (!match?.groups?.ep) continue;

    const value = Number(match.groups.ep);
    if (!isPlausibleEpisode(value)) continue;

    const rest = title.slice(match.index + match[0].length);
    if (NOT_EPISODE_SUFFIX.test(rest)) continue;

    return { episode: value };
  }

  return {};
}

/**
 * Extract structure from a release title.
 *
 * anipar handles the overwhelming majority of fansub conventions, but it does
 * return undefined for some real titles — `名侦探光之美少女！ - EP27 [简／繁] …`
 * among them — so a conservative regex pass backs it up. Anything the fallback
 * finds is marked `lowConfidence` and surfaced for review rather than being
 * silently trusted with a filename Jellyfin will index.
 */
export function parseRelease(title: string): ParsedRelease {
  const parsed = aniparParse(title);

  const result: ParsedRelease = {
    season: parsed?.season?.number,
    episode: parsed?.episode?.number,
    episodeTo: parsed?.episodesRange?.to,
    fansub: parsed?.fansub?.name,
    resolution: parsed?.file?.video?.resolution,
    subtitleLanguages: parsed?.subtitle?.languages,
    source: parsed?.source,
    extension: parsed?.file?.extension,
    lowConfidence: false
  };

  if (parsed?.episodesRange && result.episode === undefined) {
    result.episode = parsed.episodesRange.from;
  }

  // anipar is not immune to reading a date as an episode number, so its
  // result gets the same plausibility bound as the fallback's.
  if (result.episode !== undefined && !isPlausibleEpisode(result.episode)) {
    result.episode = undefined;
    result.episodeTo = undefined;
  }
  if (result.episodeTo !== undefined && !isPlausibleEpisode(result.episodeTo)) {
    result.episodeTo = undefined;
  }

  // A ".5" recap episode ("总集篇 12.5") is a real, distinct episode.
  if (result.episode !== undefined && parsed?.episode?.numberSub !== undefined) {
    result.episode = Number(`${result.episode}.${parsed.episode.numberSub}`);
  }

  if (result.episode === undefined) {
    const fallback = fallbackEpisode(title);
    if (fallback.episode !== undefined) {
      result.episode = fallback.episode;
      result.episodeTo = fallback.episodeTo;
      result.lowConfidence = true;
    }
  }

  return result;
}

// --- filesystem naming -----------------------------------------------------

// Reserved by the filesystem, or by the SMB/NFS share Jellyfin may sit behind.
// Spaces and hyphens are deliberately absent — they are ordinary title
// characters, and stripping them would mangle every name we produce.
const ILLEGAL_CHARS = /[/\\:*?"<>|]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Control characters are illegal in filenames and do turn up in scraped titles. */
function stripControlChars(input: string): string {
  let out = '';
  for (const char of input) {
    if ((char.codePointAt(0) ?? 0) >= 0x20) out += char;
  }
  return out;
}

/**
 * Make an arbitrary title safe as a single path segment. Fansub titles carry
 * slashes, colons and full-width punctuation freely, and a stray `/` would
 * silently create a nested directory rather than fail loudly.
 */
export function sanitizeName(input: string, fallback = 'Unknown'): string {
  let name = stripControlChars(input ?? '')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Trailing dots and spaces get silently dropped by Windows/SMB clients,
    // which turns "Show ." and "Show" into two paths that collide.
    .replace(/[. ]+$/, '')
    .trim();

  if (!name || WINDOWS_RESERVED.test(name)) name = fallback;

  // ext4 caps a filename at 255 bytes, and CJK runs 3 bytes per character.
  const encoder = new TextEncoder();
  while (encoder.encode(name).length > 200 && name.length > 1) {
    name = name.slice(0, -1).trim();
  }

  return name || fallback;
}

export function seriesFolderName(title: string, year?: number): string {
  const safe = sanitizeName(title);
  return year ? `${safe} (${year})` : safe;
}

export function seasonFolderName(season: number): string {
  // Jellyfin expects "Specials" for season 0; "Season 00" is not recognized.
  return season === 0 ? 'Specials' : `Season ${String(season).padStart(2, '0')}`;
}

function formatEpisodeNumber(episode: number): string {
  if (Number.isInteger(episode)) return String(episode).padStart(2, '0');
  // Recap episodes: 12.5 → "12.5", keeping the integer part padded.
  const [whole = '0', fraction = '0'] = String(episode).split('.');
  return `${whole.padStart(2, '0')}.${fraction}`;
}

/** Jellyfin's canonical episode stem: "Show Name S01E27". */
export function episodeStem(title: string, season: number, episode: number): string {
  const safe = sanitizeName(title);
  return `${safe} S${String(season).padStart(2, '0')}E${formatEpisodeNumber(episode)}`;
}

/**
 * Filename for an imported video. Episode titles deliberately stay out of the
 * name — they live in the NFO, where odd characters cannot break a path.
 */
export function episodeFileName(
  title: string,
  season: number,
  episode: number,
  extension: string
): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${episodeStem(title, season, episode)}${ext}`;
}

/**
 * Subtitle filename carrying a language tag Jellyfin understands, e.g.
 * "Show S01E27.zh-Hans.ass".
 */
export function subtitleFileName(
  title: string,
  season: number,
  episode: number,
  extension: string,
  languages?: string[]
): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const tag = jellyfinLanguageTag(languages);
  return `${episodeStem(title, season, episode)}${tag ? `.${tag}` : ''}${ext}`;
}

/** Map anipar's short CJK language markers onto BCP-47 tags. */
export function jellyfinLanguageTag(languages?: string[]): string | undefined {
  if (!languages?.length) return undefined;
  const has = (marker: string) => languages.some((l) => l.includes(marker));

  if (has('简')) return 'zh-Hans';
  if (has('繁')) return 'zh-Hant';
  if (has('中')) return 'zh';
  if (has('日')) return 'ja';
  if (has('英')) return 'en';
  return undefined;
}

export const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.ts', '.avi', '.mov', '.flv', '.webm'];
export const SUBTITLE_EXTENSIONS = ['.ass', '.ssa', '.srt', '.sub', '.vtt'];

export function isVideo(fileName: string): boolean {
  return VIDEO_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));
}

export function isSubtitle(fileName: string): boolean {
  return SUBTITLE_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));
}

/**
 * Apply a subscription's episode offset. Some fansubs number a second season
 * continuously (13, 14, …) while Bangumi restarts it at 1; an offset of 12
 * reconciles the two.
 */
export function applyOffset(episode: number, offset: number): number {
  return Number((episode - offset).toFixed(2));
}
