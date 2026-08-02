import type { BangumiEpisode, CachedSubject } from '../clients/bangumi.ts';
import { displayTitle, infoboxValue, subjectYear } from '../clients/bangumi.ts';

/**
 * Kodi-format NFO generation.
 *
 * Jellyfin's local NFO reader is the metadata source of truth for this
 * library. Writing it ourselves from Bangumi sidesteps the real problem with
 * anime: fansub-mangled Chinese and Japanese titles match badly (or not at
 * all) against TMDB/TVDB, so left to online providers a series either lands
 * with wrong metadata or none.
 */

/** XML text escaping. Bangumi summaries routinely contain & and < characters. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Normalize CRLF and trim; Bangumi returns \r\n throughout its summaries. */
function cleanText(value: string | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

function tag(name: string, value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? cleanText(value) : String(value);
  if (!text) return undefined;
  return `  <${name}>${escapeXml(text)}</${name}>`;
}

function document(root: string, lines: Array<string | undefined>): string {
  const body = lines.filter((line): line is string => Boolean(line)).join('\n');
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<${root}>\n${body}\n</${root}>\n`;
}

/** Tags that describe the release or the season, not the genre. */
const NON_GENRE_TAG = /^(?:\d{4}(?:年\d{1,2}月?)?|TV|WEB|OVA|OAD|剧场版|日本|中国|原创|漫画改|小说改|游戏改)$/;

function genresFrom(subject: CachedSubject, limit = 6): string[] {
  return (subject.tags ?? [])
    .filter((t) => !NON_GENRE_TAG.test(t.name.trim()))
    .slice(0, limit)
    .map((t) => t.name.trim())
    .filter(Boolean);
}

export interface TvShowNfoOptions {
  subject: CachedSubject;
  /** Title used in the library; usually the subscription's display title. */
  title: string;
}

export function buildTvShowNfo({ subject, title }: TvShowNfoOptions): string {
  const year = subjectYear(subject);
  const studio = infoboxValue(subject, '动画制作') ?? infoboxValue(subject, 'アニメーション制作');

  return document('tvshow', [
    tag('title', title),
    tag('originaltitle', subject.name),
    tag('sorttitle', displayTitle(subject)),
    tag('plot', subject.summary),
    tag('premiered', subject.date),
    tag('releasedate', subject.date),
    year !== undefined ? tag('year', year) : undefined,
    subject.rating?.score ? tag('rating', subject.rating.score.toFixed(1)) : undefined,
    studio ? tag('studio', studio) : undefined,
    ...genresFrom(subject).map((genre) => tag('genre', genre)),
    // Jellyfin keys local metadata off this; `default` stops online providers
    // from claiming the item with a competing id.
    `  <uniqueid type="bangumi" default="true">${subject.id}</uniqueid>`,
    `  <lockdata>false</lockdata>`
  ]);
}

export interface EpisodeNfoOptions {
  episode: BangumiEpisode | undefined;
  season: number;
  episodeNumber: number;
  /** Used when Bangumi has no entry for this episode yet. */
  fallbackTitle: string;
}

export function buildEpisodeNfo({
  episode,
  season,
  episodeNumber,
  fallbackTitle
}: EpisodeNfoOptions): string {
  const title = episode
    ? cleanText(episode.name_cn) || cleanText(episode.name) || fallbackTitle
    : fallbackTitle;

  const runtimeMinutes = episode?.duration_seconds
    ? Math.round(episode.duration_seconds / 60)
    : undefined;

  return document('episodedetails', [
    tag('title', title),
    episode?.name && episode.name_cn ? tag('originaltitle', episode.name) : undefined,
    // Integer episode numbers only — Jellyfin cannot represent a "12.5" recap
    // in <episode>, so those land on the neighbouring integer and are
    // distinguished by their filename.
    tag('season', season),
    tag('episode', Math.floor(episodeNumber)),
    tag('aired', episode?.airdate),
    tag('plot', episode?.desc),
    runtimeMinutes ? tag('runtime', runtimeMinutes) : undefined,
    episode ? `  <uniqueid type="bangumi">${episode.id}</uniqueid>` : undefined
  ]);
}

/** Find the Bangumi entry for a season-relative episode number. */
export function findEpisode(
  episodes: BangumiEpisode[],
  episodeNumber: number
): BangumiEpisode | undefined {
  const target = Math.floor(episodeNumber);
  return episodes.find((e) => e.type === 0 && (e.ep === target || e.sort === target));
}
