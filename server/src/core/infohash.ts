/**
 * Infohash normalization.
 *
 * `POST /api/v2/torrents/add` returns nothing, so the only way to track a
 * torrent we just handed to qBittorrent is to compute its hash ourselves from
 * the magnet. The catch: AnimeGarden serves both encodings — roughly two
 * thirds of its magnets use 32-character base32 infohashes
 * (`btih:22TJWEOXVMGGFVHKVS3CMMKOTASAR2FQ`), the rest 40-character hex —
 * while qBittorrent only ever reports lowercase hex.
 *
 * Comparing the raw magnet hash against qBittorrent's would therefore fail to
 * match most downloads, and would fail *silently*: the torrent downloads fine,
 * we just never see it complete. Everything goes through here first.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const HEX_RE = /^[0-9a-f]{40}$/;
const BASE32_RE = /^[A-Z2-7]{32}$/;

/** RFC 4648 base32 → bytes. Expects an already-uppercased, unpadded string. */
function base32Decode(input: string): Uint8Array {
  const out = new Uint8Array((input.length * 5) / 8);
  let bits = 0;
  let value = 0;
  let index = 0;

  for (const char of input) {
    const digit = BASE32_ALPHABET.indexOf(char);
    if (digit === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * Normalize an infohash in either encoding to lowercase hex.
 * Returns undefined for anything unrecognizable rather than throwing, so a
 * single malformed magnet cannot take down a whole polling run.
 */
export function normalizeInfoHash(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (HEX_RE.test(lower)) return lower;

  const upper = trimmed.toUpperCase();
  if (BASE32_RE.test(upper)) {
    try {
      return Buffer.from(base32Decode(upper)).toString('hex');
    } catch {
      return undefined;
    }
  }

  return undefined;
}

/** Pull the `xt=urn:btih:` infohash out of a magnet URI and normalize it. */
export function infoHashFromMagnet(magnet: string | null | undefined): string | undefined {
  if (!magnet) return undefined;
  const match = /urn:btih:([A-Za-z0-9]+)/i.exec(magnet);
  return match ? normalizeInfoHash(match[1]) : undefined;
}

/**
 * AnimeGarden splits a torrent link into `magnet` plus a `tracker` fragment
 * that is a bare query-string tail (`&dn=&tr=...`), not a standalone value.
 * Concatenating them yields the full magnet with trackers attached, which
 * matters for a Pi behind NAT where DHT alone can be slow to find peers.
 */
export function fullMagnet(magnet: string, tracker?: string | null): string {
  if (!tracker) return magnet;
  return magnet + (tracker.startsWith('&') ? tracker : `&${tracker}`);
}
