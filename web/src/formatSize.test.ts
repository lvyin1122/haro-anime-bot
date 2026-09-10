import { describe, expect, it } from 'vitest';

import { formatSize } from './api';

describe('formatSize', () => {
  it('reads bytes, which is what AnimeGarden and qBittorrent both report', () => {
    // This used to treat the value as kilobytes, so a 394MB episode was
    // displayed as 394GB. Every size on the screen was 1024× too large.
    expect(formatSize(412823552)).toBe('394 MB');
    expect(formatSize(781481984)).toBe('745 MB');
  });

  it('steps up through the units', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(4096)).toBe('4 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatSize(3 * 1024 ** 4)).toBe('3.0 TB');
  });

  it('drops the decimal where it would be noise', () => {
    expect(formatSize(1536)).toBe('2 KB');
    expect(formatSize(700 * 1024 * 1024)).toBe('700 MB');
  });

  it('has something to show for nothing', () => {
    expect(formatSize(0)).toBe('—');
    expect(formatSize(undefined)).toBe('—');
    expect(formatSize(-5)).toBe('—');
  });
});
