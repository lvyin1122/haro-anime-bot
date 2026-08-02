import { describe, expect, it } from 'vitest';

import {
  applyOffset,
  episodeFileName,
  episodeStem,
  isSubtitle,
  isVideo,
  jellyfinLanguageTag,
  parseRelease,
  sanitizeName,
  seasonFolderName,
  seriesFolderName,
  subtitleFileName
} from '../src/core/naming.ts';

/**
 * Fixtures taken verbatim from a live `GET /resources` page. Release titles
 * are the least controllable input in the system, so the cases that matter
 * are the awkward real ones rather than invented tidy ones.
 */
describe('parseRelease — episode extraction', () => {
  const cases: Array<[string, number | undefined]> = [
    // Standard " - NN " convention.
    [
      '[LoliHouse] 名侦探光之美少女♪ / Star Detective Precure! - 27 [WebRip 1080p HEVC-10bit AAC][无字幕]',
      27
    ],
    ['[ANi] Sousou no Frieren - 12 [1080P][Baha][WEB-DL][AAC AVC][CHT][MP4]', 12],
    [
      '[沸班亚马制作组] 死神 千年血战篇-祸进谭- - 42 [IQIYI WebRip 2160p NVENC EAC3][简繁内封字幕]',
      42
    ],
    // "EPnn" — anipar returns undefined for these, so the fallback covers them.
    ['名侦探光之美少女！ - EP27 [简／繁] (1080p H.264 AAC SRTx2) {名探偵プリキュア！}', 27],
    ['才女的侍从 - EP05 [简／繁] (1080p H.264 AAC SRTx2) {才女的侍從 | 才女のお世話}', 5],
    ['[MagicStar] 角醒猎人欧米茄号角 / 角醒ハンター オメガホーン EP02 [WEBDL] [1080p]', 2],
    // A version suffix must not disqualify the episode.
    ['名侦探光之美少女！ - EP27 v2 [简／繁] (1080p H.264 AAC SRTx2)', 27],
    ['[Sakurato] Some Show - 08v2 [WebRip 1080p HEVC-10bit AAC]', 8],
    // Bracketed episode numbers.
    ['[雪飄工作室][名探偵プリキュア！/名侦探光之美少女！][720p][27][繁日內嵌]', 27],
    ['[咪路fans制作组]蜡笔小新 Crayonshinchan [216][1997.1.24][1080P][简日双语]', 216],
    // SxxExx.
    ['鐵鍋料理王「鉄鍋のジャン！」Iron Wok Jan S01E05 1080p 多國字幕', 5],
    // Chinese episode markers.
    ['[某字幕组] 某番 第08话 [1080p]', 8],
    // Batch releases resolve to their first episode.
    ['[7³ACG] Kanon（第二作）/Kanon S01 | 01-24 [简繁字幕] BDrip 1080p x265 OPUS 2.0', 1],
    ['[7³ACG] 来自深渊/Meidoinabisu S01 | 01-13 [简繁字幕] BDrip 1080p AV1 OPUS 2.0', 1]
  ];

  it.each(cases)('parses %s → E%s', (title, expected) => {
    expect(parseRelease(title).episode).toBe(expected);
  });

  it('does not mistake technical parameters for episodes', () => {
    // "[Flac 16-44]" is a bit depth and sample rate, not episodes 16–44.
    const soundtrack =
      '鲁邦三世VS猫眼.音乐集.Yuji Ohno - Original soundtrack (2023 Anime Soundtrack) [Flac 16-44]';
    expect(parseRelease(soundtrack).episode).toBeUndefined();
  });

  it('rejects dates that look like episode numbers', () => {
    // anipar itself reads this 6-digit date as an episode; the plausibility
    // bound is what stops "episode 260116" reaching the library.
    const musicRelease =
      '[Hi-Res][260116][葬送的芙莉莲]TVアニメ『葬送のフリーレン 第2期』EDテーマ「The Story of Us」／milet[48kHz/24bit][FLAC]';
    expect(parseRelease(musicRelease).episode).toBeUndefined();
  });

  it('ignores non-anime releases', () => {
    expect(parseRelease('【ASMR】夏日戀曲♪-采耳療癒音聲-[WAV/MP3]').episode).toBeUndefined();
  });

  it('captures batch ranges', () => {
    const batch = parseRelease('[7³ACG] Kanon S01 | 01-24 [简繁字幕] BDrip 1080p x265');
    expect(batch.episode).toBe(1);
    expect(batch.episodeTo).toBe(24);
  });

  it('flags fallback matches as low confidence', () => {
    // anipar handles this one directly.
    expect(parseRelease('[LoliHouse] Show - 27 [WebRip 1080p HEVC-10bit AAC]').lowConfidence).toBe(
      false
    );
    // ...but not this one, so the regex fallback takes over and says so.
    expect(parseRelease('才女的侍从 - EP05 [简／繁] (1080p H.264 AAC)').lowConfidence).toBe(true);
  });

  it('extracts release metadata alongside the episode', () => {
    const parsed = parseRelease(
      '[LoliHouse] 名侦探光之美少女♪ - 27 [WebRip 1080p HEVC-10bit AAC][简繁内封字幕]'
    );
    expect(parsed.fansub).toBe('LoliHouse');
    expect(parsed.resolution).toBe('1080p');
    expect(parsed.source).toBe('WebRip');
    expect(parsed.subtitleLanguages).toEqual(expect.arrayContaining(['简', '繁']));
  });
});

describe('sanitizeName', () => {
  it('strips path separators so a title cannot create directories', () => {
    expect(sanitizeName('Fate/stay night')).toBe('Fate stay night');
    expect(sanitizeName('re:Zero')).toBe('re Zero');
    expect(sanitizeName('a\\b')).toBe('a b');
  });

  it('strips the remaining reserved characters', () => {
    expect(sanitizeName('What? Really* "Yes" <ok> |x|')).toBe('What Really Yes ok x');
  });

  it('keeps spaces, hyphens and CJK punctuation', () => {
    expect(sanitizeName('名侦探光之美少女！')).toBe('名侦探光之美少女！');
    expect(sanitizeName('Re-Kan! ~a story~')).toBe('Re-Kan! ~a story~');
  });

  it('drops trailing dots and spaces that collide on SMB shares', () => {
    expect(sanitizeName('Show Name.')).toBe('Show Name');
    expect(sanitizeName('Show Name   ')).toBe('Show Name');
  });

  it('falls back for empty and reserved names', () => {
    expect(sanitizeName('')).toBe('Unknown');
    expect(sanitizeName('///')).toBe('Unknown');
    expect(sanitizeName('CON')).toBe('Unknown');
  });

  it('truncates to stay within the 255-byte filename limit', () => {
    // CJK is 3 bytes per character, so 200 characters would overflow.
    const long = '葬'.repeat(200);
    expect(new TextEncoder().encode(sanitizeName(long)).length).toBeLessThanOrEqual(200);
  });
});

describe('library paths', () => {
  it('builds series folders with the year', () => {
    expect(seriesFolderName('葬送的芙莉莲', 2023)).toBe('葬送的芙莉莲 (2023)');
    expect(seriesFolderName('葬送的芙莉莲')).toBe('葬送的芙莉莲');
  });

  it('uses Specials for season 0, which is what Jellyfin expects', () => {
    expect(seasonFolderName(0)).toBe('Specials');
    expect(seasonFolderName(1)).toBe('Season 01');
    expect(seasonFolderName(12)).toBe('Season 12');
  });

  it('builds zero-padded SxxExx filenames', () => {
    expect(episodeStem('葬送的芙莉莲', 1, 7)).toBe('葬送的芙莉莲 S01E07');
    expect(episodeFileName('葬送的芙莉莲', 1, 27, '.mkv')).toBe('葬送的芙莉莲 S01E27.mkv');
    expect(episodeFileName('葬送的芙莉莲', 2, 3, 'mp4')).toBe('葬送的芙莉莲 S02E03.mp4');
  });

  it('keeps recap episodes distinguishable in the filename', () => {
    expect(episodeFileName('Show', 1, 12.5, '.mkv')).toBe('Show S01E12.5.mkv');
  });

  it('tags subtitles with a language Jellyfin understands', () => {
    expect(subtitleFileName('Show', 1, 27, '.ass', ['简'])).toBe('Show S01E27.zh-Hans.ass');
    expect(subtitleFileName('Show', 1, 27, '.srt', ['繁', '日'])).toBe('Show S01E27.zh-Hant.srt');
    expect(subtitleFileName('Show', 1, 27, '.ass')).toBe('Show S01E27.ass');
  });

  it('maps CJK language markers to BCP-47', () => {
    expect(jellyfinLanguageTag(['简'])).toBe('zh-Hans');
    expect(jellyfinLanguageTag(['繁'])).toBe('zh-Hant');
    expect(jellyfinLanguageTag(['日'])).toBe('ja');
    expect(jellyfinLanguageTag([])).toBeUndefined();
    expect(jellyfinLanguageTag(undefined)).toBeUndefined();
  });
});

describe('file type detection', () => {
  it('recognizes video containers', () => {
    expect(isVideo('a.mkv')).toBe(true);
    expect(isVideo('A.MP4')).toBe(true);
    expect(isVideo('a.ass')).toBe(false);
    expect(isVideo('a.nfo')).toBe(false);
  });

  it('recognizes subtitle formats', () => {
    expect(isSubtitle('a.ass')).toBe(true);
    expect(isSubtitle('a.SRT')).toBe(true);
    expect(isSubtitle('a.mkv')).toBe(false);
  });
});

describe('applyOffset', () => {
  it('reconciles continuous numbering with per-season numbering', () => {
    // A second season released as 13,14,… maps to 1,2,… with offset 12.
    expect(applyOffset(13, 12)).toBe(1);
    expect(applyOffset(24, 12)).toBe(12);
  });

  it('is a no-op at zero and survives recap numbering', () => {
    expect(applyOffset(27, 0)).toBe(27);
    expect(applyOffset(12.5, 0)).toBe(12.5);
    expect(applyOffset(13.5, 12)).toBe(1.5);
  });
});
