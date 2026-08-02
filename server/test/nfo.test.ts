import { describe, expect, it } from 'vitest';

import type { BangumiEpisode, CachedSubject } from '../src/clients/bangumi.ts';
import { buildEpisodeNfo, buildTvShowNfo, findEpisode } from '../src/core/nfo.ts';

const EPISODES: BangumiEpisode[] = [
  {
    id: 1628888,
    ep: 1,
    sort: 1,
    type: 0,
    name: '誕生！名探偵プリキュア！',
    name_cn: '诞生！名侦探光之美少女！',
    airdate: '2026-02-01',
    desc: 'A & B <plot> "quoted"',
    duration_seconds: 1463
  },
  {
    id: 1628889,
    ep: 2,
    sort: 2,
    type: 0,
    name: 'ep two',
    name_cn: '第二话',
    airdate: '2026-02-08',
    duration_seconds: 1463
  },
  // Non-main entries must never be picked up as SxxExx.
  { id: 9, ep: 1, sort: 99, type: 1, name: 'SP', name_cn: '特别篇', airdate: '2026-03-01' }
];

const SUBJECT: CachedSubject = {
  id: 611077,
  name: '名探偵プリキュア！',
  name_cn: '名侦探光之美少女！',
  summary: 'Summary with & ampersand, <angle> brackets and "quotes".\r\nSecond line.',
  date: '2026-02-01',
  platform: 'TV',
  eps: 51,
  rating: { score: 6.7, total: 100 },
  rank: 1234,
  images: { large: 'https://example.invalid/large.jpg' },
  tags: [
    { name: '魔法少女', count: 100 },
    { name: '2026年1月', count: 90 }, // seasonal tag, not a genre
    { name: 'TV', count: 80 }, // format, not a genre
    { name: '奇幻', count: 70 }
  ],
  infobox: [{ key: '动画制作', value: '東映アニメーション' }],
  episodes: EPISODES,
  fetchedAt: Date.now()
};

/**
 * Well-formedness check. Node ships no DOMParser and an XML library is not
 * worth a dependency here, so this walks the document directly: tags must
 * nest and balance, and text content must not contain a raw `&` or `<`.
 * Jellyfin ignores a malformed NFO silently, so this needs to actually hold.
 */
function assertWellFormed(xml: string): void {
  expect(xml.startsWith('<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n')).toBe(true);

  const body = xml.slice(xml.indexOf('\n') + 1);
  const stack: string[] = [];
  const token = /<(\/?)([A-Za-z][\w.-]*)(\s[^>]*?)?(\/?)>/g;

  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = token.exec(body)) !== null) {
    const [raw, closing, name, , selfClosing] = match;

    const text = body.slice(cursor, match.index);
    expect(text, `unescaped "<" in text before ${raw}`).not.toContain('<');
    // A bare & that is not the start of an entity is a parse error.
    expect(text.replace(/&(?:amp|lt|gt|quot|apos|#\d+);/g, ''), `unescaped "&" before ${raw}`)
      .not.toContain('&');
    cursor = match.index + raw.length;

    if (selfClosing) continue;
    if (closing) {
      expect(stack.pop(), `mismatched closing tag </${name}>`).toBe(name);
    } else {
      stack.push(name!);
    }
  }

  expect(stack, 'unclosed tags').toEqual([]);
}

describe('buildTvShowNfo', () => {
  const xml = buildTvShowNfo({ subject: SUBJECT, title: '名侦探光之美少女！' });

  it('emits a well-formed declaration and root element', () => {
    assertWellFormed(xml);
    expect(xml).toContain('<tvshow>');
    expect(xml.trimEnd().endsWith('</tvshow>')).toBe(true);
  });

  it('carries the Chinese title with the Japanese original', () => {
    expect(xml).toContain('<title>名侦探光之美少女！</title>');
    expect(xml).toContain('<originaltitle>名探偵プリキュア！</originaltitle>');
  });

  it('escapes XML metacharacters in the summary', () => {
    // An unescaped & or < would make Jellyfin reject the whole file.
    expect(xml).toContain('&amp; ampersand');
    expect(xml).toContain('&lt;angle&gt; brackets');
    expect(xml).toContain('&quot;quotes&quot;');
    expect(xml).not.toMatch(/<plot>[^<]*[^&]&[a-z]*[^;a-z]/);
  });

  it('pins the Bangumi id as the default unique id', () => {
    // Without `default`, online providers can claim the item and overwrite us.
    expect(xml).toContain('<uniqueid type="bangumi" default="true">611077</uniqueid>');
  });

  it('includes premiere, rating and studio', () => {
    expect(xml).toContain('<premiered>2026-02-01</premiered>');
    expect(xml).toContain('<year>2026</year>');
    expect(xml).toContain('<rating>6.7</rating>');
    expect(xml).toContain('<studio>東映アニメーション</studio>');
  });

  it('keeps genre tags but drops seasonal and format tags', () => {
    expect(xml).toContain('<genre>魔法少女</genre>');
    expect(xml).toContain('<genre>奇幻</genre>');
    expect(xml).not.toContain('<genre>2026年1月</genre>');
    expect(xml).not.toContain('<genre>TV</genre>');
  });

  it('does not duplicate the full plot into outline', () => {
    expect(xml).not.toContain('<outline>');
  });
});

describe('buildEpisodeNfo', () => {
  it('uses the Bangumi episode title and air date', () => {
    const xml = buildEpisodeNfo({
      episode: EPISODES[0],
      season: 1,
      episodeNumber: 1,
      fallbackTitle: 'Episode 1'
    });

    assertWellFormed(xml);
    expect(xml).toContain('<title>诞生！名侦探光之美少女！</title>');
    expect(xml).toContain('<originaltitle>誕生！名探偵プリキュア！</originaltitle>');
    expect(xml).toContain('<season>1</season>');
    expect(xml).toContain('<episode>1</episode>');
    expect(xml).toContain('<aired>2026-02-01</aired>');
    expect(xml).toContain('<runtime>24</runtime>');
    expect(xml).toContain('<uniqueid type="bangumi">1628888</uniqueid>');
  });

  it('escapes metacharacters in the episode plot', () => {
    const xml = buildEpisodeNfo({
      episode: EPISODES[0],
      season: 1,
      episodeNumber: 1,
      fallbackTitle: 'x'
    });
    expect(xml).toContain('A &amp; B &lt;plot&gt; &quot;quoted&quot;');
  });

  it('falls back when Bangumi has no entry for the episode', () => {
    const xml = buildEpisodeNfo({
      episode: undefined,
      season: 1,
      episodeNumber: 42,
      fallbackTitle: 'Episode 42'
    });
    expect(xml).toContain('<title>Episode 42</title>');
    expect(xml).toContain('<episode>42</episode>');
    expect(xml).not.toContain('<aired>');
  });

  it('floors a recap episode number, which Jellyfin cannot express', () => {
    const xml = buildEpisodeNfo({
      episode: undefined,
      season: 1,
      episodeNumber: 12.5,
      fallbackTitle: 'Recap'
    });
    expect(xml).toContain('<episode>12</episode>');
  });
});

describe('findEpisode', () => {
  it('matches main-story episodes only', () => {
    expect(findEpisode(EPISODES, 1)?.id).toBe(1628888);
    expect(findEpisode(EPISODES, 2)?.id).toBe(1628889);
    // ep 1 also exists as a type-1 special; the main entry must win.
    expect(findEpisode(EPISODES, 1)?.type).toBe(0);
  });

  it('floors fractional episode numbers before matching', () => {
    expect(findEpisode(EPISODES, 1.5)?.id).toBe(1628888);
  });

  it('returns undefined for unknown episodes', () => {
    expect(findEpisode(EPISODES, 99)).toBeUndefined();
  });
});
