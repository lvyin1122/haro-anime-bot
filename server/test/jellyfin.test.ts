import { describe, expect, it } from 'vitest';

import { itemUrl, matchEpisode, type JellyfinItem } from '../src/clients/jellyfin.ts';

const LIB = '/media/anime/名侦探光之美少女！ (2026)/Season 01';

const EPISODES: JellyfinItem[] = [
  {
    Id: 'ep-26',
    Name: '闪念天使的复活',
    Type: 'Episode',
    IndexNumber: 26,
    ParentIndexNumber: 1,
    Path: `${LIB}/名侦探光之美少女！ S01E26.mkv`
  },
  {
    Id: 'ep-27',
    Name: '我成为名侦探了。',
    Type: 'Episode',
    IndexNumber: 27,
    ParentIndexNumber: 1,
    Path: `${LIB}/名侦探光之美少女！ S01E27.mkv`
  }
];

describe('matchEpisode', () => {
  it('matches on exact library path', () => {
    expect(matchEpisode(EPISODES, `${LIB}/名侦探光之美少女！ S01E27.mkv`, 27)?.Id).toBe('ep-27');
  });

  it('prefers the path over the episode number when they disagree', () => {
    // Jellyfin's IndexNumber can drift from ours if an NFO says otherwise;
    // the file we hardlinked is the ground truth.
    expect(matchEpisode(EPISODES, `${LIB}/名侦探光之美少女！ S01E26.mkv`, 27)?.Id).toBe('ep-26');
  });

  it('falls back to the filename when mount prefixes differ', () => {
    // Jellyfin may see the same file under a different mount point than we do.
    expect(
      matchEpisode(EPISODES, '/different/mount/名侦探光之美少女！ S01E27.mkv', 27)?.Id
    ).toBe('ep-27');
  });

  it('falls back to the episode number when no path is recorded', () => {
    expect(matchEpisode(EPISODES, undefined, 26)?.Id).toBe('ep-26');
  });

  it('floors a recap number before matching', () => {
    expect(matchEpisode(EPISODES, undefined, 26.5)?.Id).toBe('ep-26');
  });

  it('returns undefined when nothing matches', () => {
    expect(matchEpisode(EPISODES, '/nope/other.mkv', 99)).toBeUndefined();
    expect(matchEpisode([], undefined, 1)).toBeUndefined();
  });

  it('does not match on a filename that is merely a suffix of another', () => {
    const items: JellyfinItem[] = [{ Id: 'a', Name: 'a', Type: 'Episode', Path: '/x/Show S01E01.mkv' }];
    // "E01.mkv" must not match "Show S01E01.mkv" via a bare endsWith.
    expect(matchEpisode(items, '/y/E01.mkv', 5)).toBeUndefined();
  });
});

describe('itemUrl', () => {
  it('builds a Jellyfin web deep link', () => {
    expect(itemUrl('http://192.0.2.10:8096', 'abc', 'srv')).toBe(
      'http://192.0.2.10:8096/web/index.html#/details?id=abc&serverId=srv'
    );
  });

  it('omits serverId when unknown', () => {
    expect(itemUrl('http://jf.local', 'abc')).toBe(
      'http://jf.local/web/index.html#/details?id=abc'
    );
  });

  it('tolerates a trailing slash on the base', () => {
    expect(itemUrl('https://jellyfin.example.com/', 'abc', 'srv')).toBe(
      'https://jellyfin.example.com/web/index.html#/details?id=abc&serverId=srv'
    );
  });
});
