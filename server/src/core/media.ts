/**
 * What a browser can play, and what ffmpeg has to do about it.
 *
 * Fansub releases are almost always Matroska, which no browser opens, and very
 * often 10-bit HEVC, which no browser decodes. So the built-in player takes one
 * of three routes, cheapest first:
 *
 *   direct     The file is already an MP4 of browser-safe streams. Serve it
 *              with byte ranges. ffmpeg never runs.
 *   remux      Streams are fine, the container is not. `-c copy` into fMP4
 *              segments — essentially free, and the case for most H.264 rips.
 *   transcode  Something has to be re-encoded. Expensive; on a Pi, slow.
 *
 * Remux and transcode share one delivery path (HLS with fMP4 segments) and
 * differ only in the ffmpeg codec flags, so there is a single set of moving
 * parts rather than two.
 *
 * Segments are produced one ffmpeg process at a time, on request, with no
 * session state anywhere: every segment can be generated independently, which
 * is what makes seeking instant and restarts free. `segmentPlan` is what makes
 * that safe — for a copy it snaps segment boundaries onto source keyframes,
 * because `-c copy` cannot cut anywhere else.
 *
 * Everything in this file is pure. Process spawning lives in ffmpeg.ts.
 */

// --- probe model -----------------------------------------------------------

export type StreamKind = 'video' | 'audio' | 'subtitle' | 'attachment' | 'data';

export interface MediaStream {
  /** Absolute index within the file. */
  index: number;
  /** Index within this kind — the N in `-map 0:a:N`. */
  typeIndex: number;
  kind: StreamKind;
  codec: string;
  profile?: string;
  pixFmt?: string;
  width?: number;
  height?: number;
  channels?: number;
  language?: string;
  title?: string;
  isDefault: boolean;
  forced: boolean;
  /** Cover art muxed in as a video stream. Not something to play. */
  attachedPic: boolean;
  /** Attachment streams only — usually the fonts an ASS track needs. */
  filename?: string;
  mimetype?: string;
}

export interface MediaInfo {
  /** ffprobe's `format_name`, e.g. `matroska,webm`. */
  container: string;
  durationMs: number;
  streams: MediaStream[];
}

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  channels?: number;
  duration?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

interface ProbeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: ProbeStream[];
}

const KINDS: Record<string, StreamKind> = {
  video: 'video',
  audio: 'audio',
  subtitle: 'subtitle',
  attachment: 'attachment',
  data: 'data'
};

/** Turn `ffprobe -show_streams -show_format` JSON into the model above. */
export function parseProbe(raw: string): MediaInfo {
  const probe = JSON.parse(raw) as ProbeOutput;
  const counters = new Map<StreamKind, number>();
  const streams: MediaStream[] = [];

  for (const stream of probe.streams ?? []) {
    const kind = KINDS[stream.codec_type ?? ''];
    if (!kind) continue;

    const typeIndex = counters.get(kind) ?? 0;
    counters.set(kind, typeIndex + 1);

    const tags = stream.tags ?? {};
    const disposition = stream.disposition ?? {};
    streams.push({
      index: stream.index ?? streams.length,
      typeIndex,
      kind,
      codec: (stream.codec_name ?? 'unknown').toLowerCase(),
      profile: stream.profile,
      pixFmt: stream.pix_fmt,
      width: stream.width,
      height: stream.height,
      channels: stream.channels,
      // Matroska writes ISO 639-2; ffprobe surfaces it verbatim.
      language: tags.language ?? tags.LANGUAGE,
      title: tags.title ?? tags.TITLE,
      isDefault: disposition.default === 1,
      forced: disposition.forced === 1,
      attachedPic: disposition.attached_pic === 1,
      filename: tags.filename ?? tags.FILENAME,
      mimetype: tags.mimetype ?? tags.MIMETYPE
    });
  }

  const seconds = Number(probe.format?.duration ?? 0);
  return {
    container: probe.format?.format_name ?? 'unknown',
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    streams
  };
}

// --- client capabilities ---------------------------------------------------

/**
 * What the browser told us it can decode. The client probes these with
 * `MediaSource.isTypeSupported` and sends the ones that pass, because there is
 * no way to work it out server-side: HEVC in particular depends on the
 * viewer's GPU, not their browser version.
 */
export const CAPABILITIES = [
  'h264',
  'hevc',
  'av1',
  'vp9',
  'aac',
  'opus',
  'flac',
  'mp3',
  'ac3',
  'eac3'
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Parse the `caps=` query parameter. Unknown names are ignored. */
export function parseCapabilities(raw: string | undefined | null): Set<Capability> {
  const known = new Set<string>(CAPABILITIES);
  const caps = new Set<Capability>();
  for (const part of (raw ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (known.has(name)) caps.add(name as Capability);
  }
  // A client that sends nothing gets the floor every browser has supported for
  // a decade, rather than being transcoded into oblivion or handed something
  // it cannot play.
  if (caps.size === 0) {
    caps.add('h264');
    caps.add('aac');
  }
  return caps;
}

// --- playback decision -----------------------------------------------------

export type StreamAction = 'copy' | 'encode';

export interface PlanStream {
  action: StreamAction;
  /** The N in `-map 0:v:N` / `-map 0:a:N`. */
  typeIndex: number;
  codec: string;
}

export interface PlayPlan {
  mode: 'direct' | 'hls';
  video?: PlanStream;
  audio?: PlanStream;
  /** Plain-language explanation of anything that is not a straight copy. */
  reasons: string[];
}

/** Bit depth implied by a pixel format name (`yuv420p10le` → 10). */
export function bitDepth(pixFmt: string | undefined): number {
  const match = /p(\d{1,2})(?:le|be)?$/.exec(pixFmt ?? '');
  return match ? Number(match[1]) : 8;
}

/** Browsers decode 4:2:0 only; 4:2:2 and 4:4:4 always need re-encoding. */
function isChromaSupported(pixFmt: string | undefined): boolean {
  if (!pixFmt) return true;
  return !/(422|440|444)/.test(pixFmt);
}

const CODEC_LABEL: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  vp8: 'VP8',
  mpeg4: 'MPEG-4 Part 2',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  aac: 'AAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus',
  dts: 'DTS',
  truehd: 'Dolby TrueHD',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  pcm_s16le: 'PCM'
};
const label = (codec: string): string => CODEC_LABEL[codec] ?? codec.toUpperCase();

/** Why this video stream cannot be passed through, or undefined if it can. */
function whyVideoNeedsEncoding(
  stream: MediaStream,
  caps: Set<Capability>
): string | undefined {
  const depth = bitDepth(stream.pixFmt);
  if (depth > 8) {
    return `${label(stream.codec)} ${depth}-bit — no browser decodes more than 8-bit video`;
  }
  if (!isChromaSupported(stream.pixFmt)) {
    return `${stream.pixFmt} chroma subsampling is not decodable in a browser`;
  }
  switch (stream.codec) {
    case 'h264':
      return caps.has('h264') ? undefined : 'your browser did not report H.264 support';
    case 'hevc':
      return caps.has('hevc')
        ? undefined
        : 'HEVC — this browser or GPU cannot decode it (Safari and hardware-capable Chrome can)';
    case 'av1':
      return caps.has('av1') ? undefined : 'AV1 — your browser did not report support';
    case 'vp9':
      return caps.has('vp9') ? undefined : 'VP9 — your browser did not report support';
    default:
      return `${label(stream.codec)} is not a format browsers play`;
  }
}

/** Why this audio stream cannot be passed through, or undefined if it can. */
function whyAudioNeedsEncoding(
  stream: MediaStream,
  caps: Set<Capability>
): string | undefined {
  const supported: Partial<Record<string, Capability>> = {
    aac: 'aac',
    opus: 'opus',
    flac: 'flac',
    mp3: 'mp3',
    ac3: 'ac3',
    eac3: 'eac3'
  };
  const capability = supported[stream.codec];
  if (!capability) return `${label(stream.codec)} audio is not playable in a browser`;
  return caps.has(capability)
    ? undefined
    : `${label(stream.codec)} audio — your browser did not report support`;
}

const BROWSER_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.m4a', '.webm'];

/**
 * Whether a browser will open this file as-is.
 *
 * The file extension is the reliable signal and the probe is the fallback,
 * because ffmpeg demuxes Matroska and WebM with the same code and reports both
 * as `matroska,webm`. Trusting that string alone would offer every .mkv in the
 * library as direct play and hand the browser a file it cannot open.
 */
function isBrowserContainer(container: string, extension?: string): boolean {
  if (extension) return BROWSER_EXTENSIONS.includes(extension.toLowerCase());

  const names = container.split(',').map((name) => name.trim());
  if (names.includes('matroska')) return false;
  return names.some((name) => ['mp4', 'mov', 'm4a', '3gp', 'webm'].includes(name));
}

/** Playable video streams, i.e. everything except muxed-in cover art. */
export function videoStreams(info: MediaInfo): MediaStream[] {
  return info.streams.filter((s) => s.kind === 'video' && !s.attachedPic);
}

export function audioStreams(info: MediaInfo): MediaStream[] {
  return info.streams.filter((s) => s.kind === 'audio');
}

export function subtitleStreams(info: MediaInfo): MediaStream[] {
  return info.streams.filter((s) => s.kind === 'subtitle');
}

export function attachmentStreams(info: MediaInfo): MediaStream[] {
  return info.streams.filter((s) => s.kind === 'attachment');
}

/** The track a player would pick on its own: the default one, else the first. */
export function preferredAudio(info: MediaInfo): MediaStream | undefined {
  const audio = audioStreams(info);
  return audio.find((s) => s.isDefault) ?? audio[0];
}

/**
 * Decide how to deliver this file to this browser.
 *
 * `audioTrack` is a typeIndex chosen in the UI. Picking a non-default track
 * rules out direct play even when everything else would qualify, because
 * serving the original file gives the browser no way to be told which track
 * to use.
 *
 * `extension` should be the file's own, lower-cased or not; see
 * `isBrowserContainer` for why the probe cannot settle this by itself.
 */
export function decidePlayback(
  info: MediaInfo,
  caps: Set<Capability>,
  options: { audioTrack?: number; extension?: string } = {}
): PlayPlan {
  const video = videoStreams(info)[0];
  const audioTracks = audioStreams(info);
  const preferred = preferredAudio(info);
  const audio =
    options.audioTrack === undefined
      ? preferred
      : (audioTracks.find((s) => s.typeIndex === options.audioTrack) ?? preferred);

  const reasons: string[] = [];

  const videoReason = video ? whyVideoNeedsEncoding(video, caps) : undefined;
  if (videoReason) reasons.push(videoReason);

  const audioReason = audio ? whyAudioNeedsEncoding(audio, caps) : undefined;
  if (audioReason) reasons.push(audioReason);

  const streamsAreFine = !videoReason && !audioReason;
  const containerIsFine = isBrowserContainer(info.container, options.extension);
  const usingPreferredAudio = !audio || !preferred || audio.typeIndex === preferred.typeIndex;

  if (streamsAreFine && !containerIsFine) {
    reasons.push(
      `${info.container.split(',')[0] ?? 'this container'} is not a container browsers open — ` +
        'repackaging only, nothing re-encoded'
    );
  }
  if (streamsAreFine && containerIsFine && !usingPreferredAudio) {
    reasons.push('a non-default audio track was selected, so the file is repackaged around it');
  }

  return {
    mode: streamsAreFine && containerIsFine && usingPreferredAudio ? 'direct' : 'hls',
    video: video
      ? { action: videoReason ? 'encode' : 'copy', typeIndex: video.typeIndex, codec: video.codec }
      : undefined,
    audio: audio
      ? { action: audioReason ? 'encode' : 'copy', typeIndex: audio.typeIndex, codec: audio.codec }
      : undefined,
    reasons
  };
}

/** One-word summary for the badge in the player. */
export function describePlan(plan: PlayPlan): 'direct' | 'remux' | 'transcode' {
  if (plan.mode === 'direct') return 'direct';
  if (plan.video?.action === 'encode' || plan.audio?.action === 'encode') return 'transcode';
  return 'remux';
}

// --- segmenting ------------------------------------------------------------

/** Target segment length. Long enough to keep spawn overhead irrelevant. */
export const SEGMENT_MS = 6000;
/** A trailing sliver shorter than this is folded into the segment before it. */
const MIN_TAIL_MS = 1000;

export interface Segment {
  index: number;
  startMs: number;
  durationMs: number;
}

/**
 * Cut a file into segments.
 *
 * Pass `keyframesMs` when the video is being copied: `-c copy` can only start
 * a segment at a keyframe, so boundaries have to land on real ones or the
 * first frames of every segment are undecodable. When re-encoding we choose
 * the keyframes ourselves, so uniform segments are both correct and simpler.
 */
export function segmentPlan(durationMs: number, keyframesMs?: number[]): Segment[] {
  if (durationMs <= 0) return [];

  const boundaries = keyframesMs?.length
    ? keyframeBoundaries(durationMs, keyframesMs)
    : uniformBoundaries(durationMs);

  const segments: Segment[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    segments.push({
      index: i,
      startMs: boundaries[i]!,
      durationMs: boundaries[i + 1]! - boundaries[i]!
    });
  }
  return segments;
}

function uniformBoundaries(durationMs: number): number[] {
  const boundaries = [0];
  for (let at = SEGMENT_MS; at < durationMs; at += SEGMENT_MS) boundaries.push(at);
  const last = boundaries[boundaries.length - 1]!;
  if (boundaries.length > 1 && durationMs - last < MIN_TAIL_MS) boundaries.pop();
  boundaries.push(durationMs);
  return boundaries;
}

function keyframeBoundaries(durationMs: number, keyframesMs: number[]): number[] {
  const keys = [...keyframesMs].sort((a, b) => a - b);
  const boundaries = [0];
  let last = 0;
  for (const key of keys) {
    if (key <= 0 || key >= durationMs) continue;
    if (key - last >= SEGMENT_MS) {
      boundaries.push(key);
      last = key;
    }
  }
  if (boundaries.length > 1 && durationMs - last < MIN_TAIL_MS) boundaries.pop();
  boundaries.push(durationMs);
  return boundaries;
}

/**
 * A complete VOD playlist, written up front from the segment plan rather than
 * grown as ffmpeg produces output. That is what lets the player seek anywhere
 * immediately: it knows every segment exists before any of them are made.
 */
export function buildPlaylist(
  segments: Segment[],
  uri: (segment: Segment) => string,
  initUri: string
): string {
  const targetSeconds = Math.ceil(
    segments.reduce((max, s) => Math.max(max, s.durationMs), 0) / 1000
  );

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.max(1, targetSeconds)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MAP:URI="${initUri}"`
  ];

  for (const segment of segments) {
    lines.push(`#EXTINF:${(segment.durationMs / 1000).toFixed(3)},`);
    lines.push(uri(segment));
  }

  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

// --- ffmpeg argument building ----------------------------------------------

const COMMON = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

/** Cap on transcode output. Above this we are spending CPU on pixels nobody sees. */
const MAX_HEIGHT = 1080;
const MAX_WIDTH = 1920;

/**
 * H.264 encoders in the order we would rather have them.
 *
 * Which of these exist depends on how ffmpeg was built: the image Haro ships
 * has libx264, while a distribution's patent-free package (Fedora's
 * `ffmpeg-free`, for one) may have only OpenH264. Neither absence is fatal, so
 * pick rather than require.
 *
 * Hardware encoders are deliberately absent. ffmpeg lists h264_vaapi,
 * h264_v4l2m2m and friends on machines that cannot actually use them — the
 * device may be missing, unusable from inside the container, or lack an H.264
 * profile — and the failure only shows up when the first segment is requested.
 * Choosing one would need a probe encode, not a listing.
 */
export const H264_ENCODERS = ['libx264', 'libopenh264'] as const;
export const DEFAULT_H264_ENCODER = 'libx264';

/** Quality settings, which are not portable between encoders. */
const ENCODER_ARGS: Record<string, string[]> = {
  libx264: ['-preset', 'veryfast', '-crf', '23', '-profile:v', 'high'],
  // OpenH264 has no constant-quality mode; a bitrate ceiling is all it takes.
  libopenh264: ['-b:v', '4M', '-profile:v', 'high'],
  // Hardware encoders, if one is ever configured explicitly: no presets, no
  // CRF, and they will not be argued with about profiles either.
  h264_v4l2m2m: ['-b:v', '4M'],
  h264_vaapi: ['-b:v', '4M']
};

function videoCodecArgs(plan: PlayPlan, encoder: string): string[] {
  if (!plan.video) return ['-vn'];
  if (plan.video.action === 'copy') return ['-c:v', 'copy'];
  return [
    '-c:v',
    encoder,
    ...(ENCODER_ARGS[encoder] ?? ['-b:v', '4M']),
    '-pix_fmt',
    'yuv420p',
    // Each segment is encoded from scratch, so its first frame is already an
    // IDR; this only stops the encoder inserting more than it needs to inside
    // one.
    '-g',
    '240',
    '-vf',
    `scale='min(${MAX_WIDTH},iw)':'min(${MAX_HEIGHT},ih)':` +
      'force_original_aspect_ratio=decrease:force_divisible_by=2'
  ];
}

function audioCodecArgs(plan: PlayPlan): string[] {
  if (!plan.audio) return ['-an'];
  if (plan.audio.action === 'copy') return ['-c:a', 'copy'];
  // Downmix: surround in a browser is a coin flip, and stereo always works.
  return ['-c:a', 'aac', '-ac', '2', '-b:a', '192k'];
}

function mapArgs(plan: PlayPlan): string[] {
  const args: string[] = [];
  if (plan.video) args.push('-map', `0:v:${plan.video.typeIndex}`);
  if (plan.audio) args.push('-map', `0:a:${plan.audio.typeIndex}`);
  // Subtitles are delivered separately and rendered over the video, so they
  // must not end up in the fMP4 — MSE would reject the track outright.
  args.push('-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1');
  return args;
}

const FRAGMENT_ARGS = [
  '-movflags',
  '+frag_keyframe+empty_moov+default_base_moof',
  '-muxdelay',
  '0',
  '-muxpreload',
  '0',
  '-f',
  'mp4',
  'pipe:1'
];

/**
 * Produce the HLS init segment (`ftyp` + `moov`).
 *
 * There is no ffmpeg flag for "header only", so this muxes a fraction of a
 * second and the caller keeps the leading boxes; `empty_moov` means the moov
 * carries stream configuration and no sample tables, which is exactly an
 * init segment.
 */
export function initSegmentArgs(
  file: string,
  plan: PlayPlan,
  encoder: string = DEFAULT_H264_ENCODER
): string[] {
  return [
    ...COMMON,
    '-i',
    file,
    '-t',
    '0.1',
    ...mapArgs(plan),
    ...videoCodecArgs(plan, encoder),
    ...audioCodecArgs(plan),
    ...FRAGMENT_ARGS
  ];
}

/**
 * Produce one media segment.
 *
 * `-ss` before `-i` is an input seek, so ffmpeg jumps rather than decoding up
 * to the start point, and `-output_ts_offset` puts the fragment back on the
 * global timeline — without it every segment would claim to start at zero and
 * the player would stack them all on top of each other.
 */
export function mediaSegmentArgs(
  file: string,
  plan: PlayPlan,
  segment: Segment,
  encoder: string = DEFAULT_H264_ENCODER
): string[] {
  const startSeconds = (segment.startMs / 1000).toFixed(6);
  return [
    ...COMMON,
    '-ss',
    startSeconds,
    '-i',
    file,
    '-t',
    // Exclusive of a packet landing exactly on the end boundary, which is what
    // keeps consecutive segments from both containing the keyframe they share.
    (segment.durationMs / 1000).toFixed(6),
    ...mapArgs(plan),
    ...videoCodecArgs(plan, encoder),
    ...audioCodecArgs(plan),
    '-output_ts_offset',
    startSeconds,
    ...FRAGMENT_ARGS
  ];
}

/** Text subtitle formats we can hand to the browser, keyed by ffprobe codec. */
export const TEXT_SUBTITLE_CODECS: Record<string, 'ass' | 'webvtt'> = {
  ass: 'ass',
  ssa: 'ass',
  subrip: 'webvtt',
  srt: 'webvtt',
  webvtt: 'webvtt',
  mov_text: 'webvtt',
  text: 'webvtt'
};

/**
 * Extract one embedded subtitle track.
 *
 * ASS stays ASS: it carries the positioning, fades and typesetting that make
 * fansub subtitles legible, all of which WebVTT would throw away. Everything
 * else becomes WebVTT, which `<track>` renders natively.
 */
export function subtitleExtractArgs(
  file: string,
  typeIndex: number,
  format: 'ass' | 'webvtt'
): string[] {
  return [
    ...COMMON,
    '-i',
    file,
    '-map',
    `0:s:${typeIndex}`,
    '-c:s',
    format === 'ass' ? 'copy' : 'webvtt',
    '-f',
    format,
    'pipe:1'
  ];
}

/**
 * Dump one attachment (a font, in practice) to `outPath`.
 *
 * `-dump_attachment` is an input option and happens while the input is being
 * opened, so the trailing null output exists only to give ffmpeg somewhere to
 * write nothing to.
 */
export function attachmentDumpArgs(file: string, typeIndex: number, outPath: string): string[] {
  return [
    ...COMMON,
    `-dump_attachment:t:${typeIndex}`,
    outPath,
    '-i',
    file,
    '-t',
    '0.01',
    '-f',
    'null',
    '-'
  ];
}

/** ffprobe arguments for the container/stream inventory. */
export function probeArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file
  ];
}

/**
 * ffprobe arguments for keyframe timestamps.
 *
 * Reads packet headers only — no decoding — so this is an index walk rather
 * than a pass over the video, but it still touches the whole file and is the
 * reason probes are cached.
 */
export function keyframeProbeArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-select_streams',
    'v:0',
    '-skip_frame',
    'nokey',
    '-show_entries',
    'packet=pts_time,flags',
    '-print_format',
    'csv=print_section=0',
    file
  ];
}

/** Parse `keyframeProbeArgs` output into millisecond timestamps. */
export function parseKeyframes(csv: string): number[] {
  const times: number[] = [];
  for (const line of csv.split('\n')) {
    const [time, flags] = line.split(',');
    if (!time || !flags?.startsWith('K')) continue;
    const seconds = Number(time);
    if (Number.isFinite(seconds)) times.push(Math.round(seconds * 1000));
  }
  return times.sort((a, b) => a - b);
}

/** Pick the best available H.264 encoder out of `ffmpeg -encoders` output. */
export function chooseH264Encoder(encodersOutput: string): string {
  const available = new Set(
    encodersOutput
      .split('\n')
      // Lines look like ` V....D libx264   libx264 H.264 ...` — the flags come
      // first and the encoder name is the second field.
      .map((line) => /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name))
  );
  return H264_ENCODERS.find((name) => available.has(name)) ?? DEFAULT_H264_ENCODER;
}

// --- fragmented MP4 boxes --------------------------------------------------

interface Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** 8, or 16 for a 64-bit `largesize` box. */
  headerSize: number;
  /** Total size including the header. */
  size: number;
}

/** Walk the boxes between two offsets. Stops rather than throwing on garbage. */
function* iterateBoxes(buffer: Buffer, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset; // box extends to the end of the stream
    }
    if (size < headerSize || offset + size > end) return;

    yield { type, start: offset, headerSize, size };
    offset += size;
  }
}

function findBox(buffer: Buffer, type: string, start: number, end: number): Box | undefined {
  for (const box of iterateBoxes(buffer, start, end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

/** Payload bounds of a box, i.e. everything after its header. */
const payload = (box: Box): [number, number] => [
  box.start + box.headerSize,
  box.start + box.size
];

/**
 * Split ffmpeg's fMP4 output into its init half (`ftyp` + `moov`) and its
 * media half (everything from the first `moof`).
 *
 * ffmpeg always writes both, but HLS wants them apart: the init segment is
 * fetched once via `#EXT-X-MAP` and every media segment after it must be
 * moof/mdat only. Repeating the header inside each segment is something some
 * browsers tolerate and others reject, so it is cleaner to cut it off here —
 * this only walks top-level box headers, so it is a handful of reads.
 */
export function splitFragmentedMp4(buffer: Buffer): { init: Buffer; media: Buffer } {
  for (const box of iterateBoxes(buffer, 0, buffer.length)) {
    if (box.type === 'moof' || box.type === 'mdat') {
      return { init: buffer.subarray(0, box.start), media: buffer.subarray(box.start) };
    }
  }
  // No fragment found: hand the whole thing back as the init segment, which is
  // exactly right for initSegmentArgs and harmless otherwise.
  return { init: buffer, media: Buffer.alloc(0) };
}

/**
 * Read each track's id and timescale out of an init segment.
 *
 * Needed because sample timestamps are expressed in per-track units — 16000
 * for this video, 44100 for its audio — so an offset in milliseconds means
 * nothing until it is converted per track.
 */
export function parseTrackTimescales(init: Buffer): Map<number, number> {
  const timescales = new Map<number, number>();
  const moov = findBox(init, 'moov', 0, init.length);
  if (!moov) return timescales;

  for (const trak of iterateBoxes(init, ...payload(moov))) {
    if (trak.type !== 'trak') continue;

    const tkhd = findBox(init, 'tkhd', ...payload(trak));
    const mdia = findBox(init, 'mdia', ...payload(trak));
    if (!tkhd || !mdia) continue;
    const mdhd = findBox(init, 'mdhd', ...payload(mdia));
    if (!mdhd) continue;

    // Both are full boxes: a version byte, three flag bytes, then fields whose
    // width depends on the version (creation/modification times).
    const tkhdBody = tkhd.start + tkhd.headerSize;
    const trackId = init.readUInt32BE(tkhdBody + (init[tkhdBody] === 1 ? 20 : 12));

    const mdhdBody = mdhd.start + mdhd.headerSize;
    const timescale = init.readUInt32BE(mdhdBody + (init[mdhdBody] === 1 ? 20 : 12));

    if (timescale > 0) timescales.set(trackId, timescale);
  }
  return timescales;
}

/**
 * Move a media segment onto the global timeline.
 *
 * ffmpeg numbers every output it produces from zero, and no combination of
 * `-copyts`, `-output_ts_offset` or `-avoid_negative_ts` changes what the mp4
 * muxer writes into `tfdt` — so a segment cut from ten minutes in still claims
 * to start at zero, and a player would stack every segment on top of the
 * first. The values inside one segment are correctly *relative*, though, so
 * adding the segment's start time to each of them is all that is needed.
 *
 * `tfdt` is a fixed-width field, so this rewrites in place: no box grows, no
 * offset moves, and nothing else in the segment has to be touched.
 */
export function offsetFragmentTimestamps(
  media: Buffer,
  startMs: number,
  timescales: Map<number, number>
): Buffer {
  if (startMs <= 0 || timescales.size === 0) return media;
  const out = Buffer.from(media);

  for (const moof of iterateBoxes(out, 0, out.length)) {
    if (moof.type !== 'moof') continue;

    for (const traf of iterateBoxes(out, ...payload(moof))) {
      if (traf.type !== 'traf') continue;

      const tfhd = findBox(out, 'tfhd', ...payload(traf));
      const tfdt = findBox(out, 'tfdt', ...payload(traf));
      if (!tfhd || !tfdt) continue;

      // tfhd full box: version + flags, then track_ID.
      const trackId = out.readUInt32BE(tfhd.start + tfhd.headerSize + 4);
      const timescale = timescales.get(trackId);
      // An unknown track is left alone: a wrong offset is worse than none.
      if (!timescale) continue;

      const offset = BigInt(Math.round((startMs * timescale) / 1000));
      const body = tfdt.start + tfdt.headerSize;
      if (out[body] === 1) {
        out.writeBigUInt64BE(out.readBigUInt64BE(body + 4) + offset, body + 4);
      } else {
        out.writeUInt32BE(Number(BigInt(out.readUInt32BE(body + 4)) + offset), body + 4);
      }
    }
  }

  return out;
}
