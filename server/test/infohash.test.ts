import { describe, expect, it } from 'vitest';

import { fullMagnet, infoHashFromMagnet, normalizeInfoHash } from '../src/core/infohash.ts';

describe('normalizeInfoHash', () => {
  it('decodes base32 to hex', () => {
    // Roughly two thirds of AnimeGarden magnets use this form, while
    // qBittorrent only ever reports hex — getting this wrong silently breaks
    // progress tracking for most downloads.
    expect(normalizeInfoHash('22TJWEOXVMGGFVHKVS3CMMKOTASAR2FQ')).toBe(
      'd6a69b11d7ab0c62d4eaacb626314e982408e8b0'
    );
    expect(normalizeInfoHash('5GUPG3B2SNOFM3OSQ6BLBZM47DDEHRO3')).toBe(
      'e9a8f36c3a935c566dd28782b0e59cf8c643c5db'
    );
  });

  it('passes hex through, lowercased', () => {
    const hex = 'D6A69B11D7AB0C62D4EAACB626314E982408E8B0';
    expect(normalizeInfoHash(hex)).toBe(hex.toLowerCase());
    expect(normalizeInfoHash(hex.toLowerCase())).toBe(hex.toLowerCase());
  });

  it('is idempotent', () => {
    const once = normalizeInfoHash('22TJWEOXVMGGFVHKVS3CMMKOTASAR2FQ')!;
    expect(normalizeInfoHash(once)).toBe(once);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeInfoHash('  22TJWEOXVMGGFVHKVS3CMMKOTASAR2FQ \n')).toBe(
      'd6a69b11d7ab0c62d4eaacb626314e982408e8b0'
    );
  });

  it('returns undefined rather than throwing on bad input', () => {
    // A single malformed magnet must not abort an entire polling run.
    for (const bad of [
      undefined,
      null,
      '',
      '   ',
      'not-a-hash',
      // 32 chars but 0/1/8/9 are outside the base32 alphabet.
      '01234567890123456789012345678901',
      'd6a69b11d7ab0c62d4eaacb626314e982408e8', // 38 hex chars
      'd6a69b11d7ab0c62d4eaacb626314e982408e8b0ff' // 42 hex chars
    ]) {
      expect(normalizeInfoHash(bad)).toBeUndefined();
    }
  });
});

describe('infoHashFromMagnet', () => {
  it('extracts and normalizes both encodings', () => {
    expect(infoHashFromMagnet('magnet:?xt=urn:btih:22TJWEOXVMGGFVHKVS3CMMKOTASAR2FQ')).toBe(
      'd6a69b11d7ab0c62d4eaacb626314e982408e8b0'
    );
    expect(
      infoHashFromMagnet('magnet:?xt=urn:btih:d6a69b11d7ab0c62d4eaacb626314e982408e8b0&dn=x')
    ).toBe('d6a69b11d7ab0c62d4eaacb626314e982408e8b0');
  });

  it('handles trailing parameters and mixed case schemes', () => {
    expect(
      infoHashFromMagnet('magnet:?xt=urn:BTIH:22TJWEOXVMGGFVHKVS3CMMKOTASAR2FQ&tr=http://x/announce')
    ).toBe('d6a69b11d7ab0c62d4eaacb626314e982408e8b0');
  });

  it('returns undefined for a magnet with no infohash', () => {
    expect(infoHashFromMagnet('magnet:?dn=something')).toBeUndefined();
    expect(infoHashFromMagnet('')).toBeUndefined();
  });
});

describe('fullMagnet', () => {
  it('appends the tracker fragment', () => {
    // AnimeGarden's `tracker` is a bare query-string tail, not a full value.
    expect(fullMagnet('magnet:?xt=urn:btih:abc', '&dn=&tr=http%3A%2F%2Fx')).toBe(
      'magnet:?xt=urn:btih:abc&dn=&tr=http%3A%2F%2Fx'
    );
  });

  it('inserts the separator when the fragment lacks one', () => {
    expect(fullMagnet('magnet:?xt=urn:btih:abc', 'tr=http%3A%2F%2Fx')).toBe(
      'magnet:?xt=urn:btih:abc&tr=http%3A%2F%2Fx'
    );
  });

  it('leaves the magnet alone when there is no tracker', () => {
    expect(fullMagnet('magnet:?xt=urn:btih:abc')).toBe('magnet:?xt=urn:btih:abc');
    expect(fullMagnet('magnet:?xt=urn:btih:abc', '')).toBe('magnet:?xt=urn:btih:abc');
  });
});
