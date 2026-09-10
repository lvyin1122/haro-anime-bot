/**
 * What this browser can actually decode.
 *
 * The server cannot work this out from a user-agent string: HEVC support in
 * particular depends on the machine's GPU rather than the browser version, and
 * `MediaSource.isTypeSupported` is the only honest answer available. Whatever
 * comes back here decides which streams get passed through untouched and which
 * have to be re-encoded, so it is worth asking rather than assuming.
 */

/** Codec strings to probe, paired with the capability name the server knows. */
const PROBES: Array<[capability: string, mime: string]> = [
  // avc1.640028 — High profile, level 4.0. The floor for anything modern.
  ['h264', 'video/mp4; codecs="avc1.640028"'],
  // hvc1.1.6.L93.B0 — HEVC Main profile, 8-bit.
  ['hevc', 'video/mp4; codecs="hvc1.1.6.L93.B0"'],
  ['av1', 'video/mp4; codecs="av01.0.05M.08"'],
  ['vp9', 'video/mp4; codecs="vp09.00.10.08"'],
  ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
  ['opus', 'audio/mp4; codecs="opus"'],
  ['flac', 'audio/mp4; codecs="flac"'],
  ['mp3', 'audio/mp4; codecs="mp4a.40.34"'],
  ['ac3', 'audio/mp4; codecs="ac-3"'],
  ['eac3', 'audio/mp4; codecs="ec-3"']
];

let cached: string | undefined;

/**
 * A comma-separated capability list for the `caps=` query parameter.
 *
 * Probed once per page load — the answer cannot change without a reload, and
 * `isTypeSupported` is not free.
 */
export function browserCapabilities(): string {
  if (cached !== undefined) return cached;

  const supported: string[] = [];
  const mediaSource = typeof MediaSource !== 'undefined' ? MediaSource : undefined;

  for (const [capability, mime] of PROBES) {
    const viaMse = mediaSource?.isTypeSupported(mime) ?? false;
    // A browser without MSE can still direct-play, so fall back to asking a
    // detached <video> the same question.
    const viaElement = viaMse || canPlay(mime);
    if (viaElement) supported.push(capability);
  }

  cached = supported.join(',');
  return cached;
}

function canPlay(mime: string): boolean {
  try {
    return document.createElement('video').canPlayType(mime) === 'probably';
  } catch {
    return false;
  }
}
