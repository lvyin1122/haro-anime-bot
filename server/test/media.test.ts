import { describe, expect, it } from 'vitest';

import {
  SEGMENT_MS,
  bitDepth,
  chooseH264Encoder,
  buildPlaylist,
  decidePlayback,
  describePlan,
  parseCapabilities,
  parseKeyframes,
  parseProbe,
  segmentPlan,
  splitFragmentedMp4,
  offsetFragmentTimestamps,
  parseTrackTimescales,
  type MediaInfo
} from '../src/core/media.ts';

// --- fixtures --------------------------------------------------------------

/** Shape of a real `ffprobe -show_format -show_streams` payload, trimmed. */
function probeJson(options: {
  container: string;
  duration?: number;
  streams: Record<string, unknown>[];
}): string {
  return JSON.stringify({
    format: { format_name: options.container, duration: String(options.duration ?? 1440.5) },
    streams: options.streams.map((stream, index) => ({ index, ...stream }))
  });
}

const h264Stream = {
  codec_type: 'video',
  codec_name: 'h264',
  profile: 'High',
  pix_fmt: 'yuv420p',
  width: 1920,
  height: 1080,
  disposition: { default: 1 }
};
const hevc10Stream = {
  codec_type: 'video',
  codec_name: 'hevc',
  profile: 'Main 10',
  pix_fmt: 'yuv420p10le',
  width: 1920,
  height: 1080,
  disposition: { default: 1 }
};
const aacStream = {
  codec_type: 'audio',
  codec_name: 'aac',
  channels: 2,
  disposition: { default: 1 },
  tags: { language: 'jpn' }
};
const flacStream = { codec_type: 'audio', codec_name: 'flac', channels: 2, disposition: {} };

const caps = (...names: string[]) => parseCapabilities(names.join(','));
const baseline = caps('h264', 'aac');

// --- parseProbe ------------------------------------------------------------

describe('parseProbe', () => {
  it('numbers streams within their own kind, which is what -map needs', () => {
    const info = parseProbe(
      probeJson({
        container: 'matroska,webm',
        streams: [
          h264Stream,
          aacStream,
          { codec_type: 'audio', codec_name: 'aac', channels: 6, disposition: {} },
          { codec_type: 'subtitle', codec_name: 'ass', disposition: { default: 1 } },
          { codec_type: 'attachment', codec_name: 'ttf', tags: { filename: 'Gothic.ttf' } }
        ]
      })
    );

    expect(info.streams.filter((s) => s.kind === 'audio').map((s) => s.typeIndex)).toEqual([0, 1]);
    expect(info.streams.find((s) => s.kind === 'subtitle')?.typeIndex).toBe(0);
    expect(info.streams.find((s) => s.kind === 'attachment')?.filename).toBe('Gothic.ttf');
    expect(info.durationMs).toBe(1_440_500);
  });

  it('reads language and default/forced dispositions', () => {
    const info = parseProbe(
      probeJson({
        container: 'matroska,webm',
        streams: [
          h264Stream,
          aacStream,
          {
            codec_type: 'subtitle',
            codec_name: 'ass',
            disposition: { forced: 1 },
            tags: { language: 'chi', title: '简体中文' }
          }
        ]
      })
    );

    const subtitle = info.streams.find((s) => s.kind === 'subtitle')!;
    expect(subtitle.language).toBe('chi');
    expect(subtitle.title).toBe('简体中文');
    expect(subtitle.forced).toBe(true);
    expect(subtitle.isDefault).toBe(false);
  });

  it('does not offer muxed-in cover art as a video stream to play', () => {
    const info = parseProbe(
      probeJson({
        container: 'matroska,webm',
        streams: [
          h264Stream,
          { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
          aacStream
        ]
      })
    );
    const plan = decidePlayback(info, baseline);
    expect(plan.video?.codec).toBe('h264');
  });
});

// --- capabilities ----------------------------------------------------------

describe('parseCapabilities', () => {
  it('ignores names it does not know', () => {
    expect([...caps('h264', 'wobble', 'aac')].sort()).toEqual(['aac', 'h264']);
  });

  it('falls back to the universal baseline when a client sends nothing', () => {
    expect([...parseCapabilities(undefined)].sort()).toEqual(['aac', 'h264']);
  });
});

// --- decidePlayback --------------------------------------------------------

describe('decidePlayback', () => {
  it('direct-plays an MP4 that is already browser-safe', () => {
    const info = parseProbe(probeJson({ container: 'mov,mp4,m4a', streams: [h264Stream, aacStream] }));
    const plan = decidePlayback(info, baseline);

    expect(plan.mode).toBe('direct');
    expect(describePlan(plan)).toBe('direct');
    expect(plan.reasons).toEqual([]);
  });

  it('remuxes Matroska without re-encoding either stream', () => {
    const info = parseProbe(
      probeJson({ container: 'matroska,webm', streams: [h264Stream, aacStream] })
    );
    const plan = decidePlayback(info, baseline);

    expect(plan.mode).toBe('hls');
    expect(plan.video?.action).toBe('copy');
    expect(plan.audio?.action).toBe('copy');
    expect(describePlan(plan)).toBe('remux');
    expect(plan.reasons.join(' ')).toMatch(/nothing re-encoded/);
  });

  it('transcodes 10-bit video no matter what the browser claims to support', () => {
    const info = parseProbe(
      probeJson({ container: 'matroska,webm', streams: [hevc10Stream, aacStream] })
    );
    const plan = decidePlayback(info, caps('h264', 'hevc', 'aac'));

    expect(plan.video?.action).toBe('encode');
    expect(describePlan(plan)).toBe('transcode');
    expect(plan.reasons.join(' ')).toMatch(/10-bit/);
  });

  it('copies 8-bit HEVC when the client says it can decode it', () => {
    const hevc8 = { ...hevc10Stream, profile: 'Main', pix_fmt: 'yuv420p' };
    const info = parseProbe(probeJson({ container: 'matroska,webm', streams: [hevc8, aacStream] }));

    expect(decidePlayback(info, caps('h264', 'hevc', 'aac')).video?.action).toBe('copy');
    expect(decidePlayback(info, baseline).video?.action).toBe('encode');
  });

  it('re-encodes only the audio when only the audio is a problem', () => {
    const info = parseProbe(
      probeJson({ container: 'matroska,webm', streams: [h264Stream, flacStream] })
    );
    const plan = decidePlayback(info, baseline);

    expect(plan.video?.action).toBe('copy');
    expect(plan.audio?.action).toBe('encode');
    expect(plan.reasons.join(' ')).toMatch(/FLAC/);
  });

  it('does not mistake Matroska for WebM, which ffprobe reports identically', () => {
    // ffmpeg demuxes both with one demuxer and calls the format "matroska,webm",
    // so only the extension separates a playable .webm from an unplayable .mkv.
    const info = parseProbe(
      probeJson({ container: 'matroska,webm', streams: [h264Stream, aacStream] })
    );

    expect(decidePlayback(info, baseline, { extension: '.mkv' }).mode).toBe('hls');
    expect(decidePlayback(info, baseline, { extension: '.webm' }).mode).toBe('direct');
    // With no extension to go on, Matroska is assumed rather than guessed at.
    expect(decidePlayback(info, baseline).mode).toBe('hls');
  });

  it('trusts the extension over the probe for MP4 too', () => {
    const info = parseProbe(
      probeJson({ container: 'mov,mp4,m4a', streams: [h264Stream, aacStream] })
    );
    expect(decidePlayback(info, baseline, { extension: '.mp4' }).mode).toBe('direct');
    // A .ts rip that ffprobe happens to read as MP4 is still not directly playable.
    expect(decidePlayback(info, baseline, { extension: '.ts' }).mode).toBe('hls');
  });

  it('rejects 4:2:2 chroma, which browsers cannot decode at any bit depth', () => {
    const info = parseProbe(
      probeJson({
        container: 'mov,mp4,m4a',
        streams: [{ ...h264Stream, profile: 'High 4:2:2', pix_fmt: 'yuv422p' }, aacStream]
      })
    );
    expect(decidePlayback(info, baseline).video?.action).toBe('encode');
  });

  it('picks the default audio track rather than the first', () => {
    const info = parseProbe(
      probeJson({
        container: 'matroska,webm',
        streams: [
          h264Stream,
          { codec_type: 'audio', codec_name: 'aac', disposition: {} },
          { codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } }
        ]
      })
    );
    expect(decidePlayback(info, baseline).audio?.typeIndex).toBe(1);
  });

  it('gives up direct play when a non-default audio track is chosen', () => {
    const info = parseProbe(
      probeJson({
        container: 'mov,mp4,m4a',
        streams: [
          h264Stream,
          aacStream,
          { codec_type: 'audio', codec_name: 'aac', disposition: {} }
        ]
      })
    );

    expect(decidePlayback(info, baseline, { audioTrack: 0 }).mode).toBe('direct');
    const switched = decidePlayback(info, baseline, { audioTrack: 1 });
    expect(switched.mode).toBe('hls');
    expect(switched.audio?.action).toBe('copy');
    expect(switched.reasons.join(' ')).toMatch(/non-default audio track/);
  });

  it('falls back to the default track when asked for one that does not exist', () => {
    const info = parseProbe(
      probeJson({ container: 'matroska,webm', streams: [h264Stream, aacStream] })
    );
    expect(decidePlayback(info, baseline, { audioTrack: 7 }).audio?.typeIndex).toBe(0);
  });
});

describe('bitDepth', () => {
  it.each([
    ['yuv420p', 8],
    ['yuv420p10le', 10],
    ['yuv444p12le', 12],
    [undefined, 8]
  ])('%s → %i', (pixFmt, expected) => {
    expect(bitDepth(pixFmt as string | undefined)).toBe(expected);
  });
});

// --- segmenting ------------------------------------------------------------

describe('segmentPlan', () => {
  it('cuts uniform segments when we control the keyframes', () => {
    const segments = segmentPlan(20_000);

    expect(segments.map((s) => s.startMs)).toEqual([0, 6000, 12_000, 18_000]);
    expect(segments.at(-1)).toEqual({ index: 3, startMs: 18_000, durationMs: 2000 });
  });

  it('covers the whole file exactly, with no gap or overlap', () => {
    for (const duration of [1000, 6000, 6001, 25_500, 1_440_500]) {
      const segments = segmentPlan(duration);
      expect(segments[0]?.startMs).toBe(0);
      expect(segments.at(-1)!.startMs + segments.at(-1)!.durationMs).toBe(duration);
      for (let i = 1; i < segments.length; i++) {
        expect(segments[i]!.startMs).toBe(segments[i - 1]!.startMs + segments[i - 1]!.durationMs);
      }
    }
  });

  it('folds a sliver of a final segment into the one before it', () => {
    // 6.4s would otherwise leave a 400ms trailing segment.
    const segments = segmentPlan(6400);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.durationMs).toBe(6400);
  });

  it('snaps to source keyframes when the video is being copied', () => {
    // Keyframes every 2.5s; segments must land on them, never between.
    const keyframes = Array.from({ length: 12 }, (_, i) => i * 2500);
    const segments = segmentPlan(30_000, keyframes);

    for (const segment of segments) {
      expect(keyframes).toContain(segment.startMs);
    }
    expect(segments.every((s) => s.durationMs >= SEGMENT_MS || s === segments.at(-1))).toBe(true);
  });

  it('handles keyframes far apart without producing a segment shorter than the gap', () => {
    const segments = segmentPlan(40_000, [0, 20_000]);
    expect(segments.map((s) => s.startMs)).toEqual([0, 20_000]);
  });

  it('returns nothing for a file of unknown length rather than one bad segment', () => {
    expect(segmentPlan(0)).toEqual([]);
  });
});

describe('buildPlaylist', () => {
  it('writes a complete VOD playlist so the player can seek immediately', () => {
    const playlist = buildPlaylist(segmentPlan(14_000), (s) => `${s.index}.m4s`, 'init.mp4');

    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist.trimEnd().endsWith('#EXT-X-ENDLIST')).toBe(true);
    expect(playlist).toContain('#EXTINF:6.000,\n0.m4s');
    expect(playlist).toContain('#EXTINF:2.000,\n2.m4s');
    // Target duration must be >= the longest segment or players stall.
    expect(playlist).toContain('#EXT-X-TARGETDURATION:6');
  });
});

describe('parseKeyframes', () => {
  it('keeps keyframe packets and drops the rest', () => {
    const csv = ['0.000000,K__', '0.041708,___', '2.502500,K__', 'bad line', ''].join('\n');
    expect(parseKeyframes(csv)).toEqual([0, 2503]);
  });
});

// --- encoder selection -----------------------------------------------------

describe('chooseH264Encoder', () => {
  // Verbatim shape of `ffmpeg -encoders` output.
  const line = (name: string) => ` V....D ${name}             some description (codec h264)`;

  it('prefers libx264 when the build has it', () => {
    expect(chooseH264Encoder([line('libopenh264'), line('libx264')].join('\n'))).toBe('libx264');
  });

  it('ignores hardware encoders, which ffmpeg lists whether or not they work', () => {
    expect(chooseH264Encoder([line('h264_vaapi'), line('h264_v4l2m2m')].join('\n'))).toBe(
      'libx264'
    );
    expect(
      chooseH264Encoder([line('h264_v4l2m2m'), line('libopenh264')].join('\n'))
    ).toBe('libopenh264');
  });

  it('falls back to OpenH264 on a build without libx264, as Fedora ships', () => {
    expect(chooseH264Encoder([line('libopenh264'), line('h264_vaapi')].join('\n'))).toBe(
      'libopenh264'
    );
  });

  it('does not match a substring of a longer encoder name', () => {
    expect(chooseH264Encoder(line('libx264rgb'))).toBe('libx264');
  });
});

// --- fMP4 box splitting ----------------------------------------------------

describe('splitFragmentedMp4', () => {
  const box = (type: string, payload = 4) => {
    const buffer = Buffer.alloc(8 + payload);
    buffer.writeUInt32BE(8 + payload, 0);
    buffer.write(type, 4, 'ascii');
    return buffer;
  };

  it('splits ffmpeg output into init and media halves at the first moof', () => {
    const ftyp = box('ftyp');
    const moov = box('moov', 16);
    const moof = box('moof', 12);
    const mdat = box('mdat', 64);

    const { init, media } = splitFragmentedMp4(Buffer.concat([ftyp, moov, moof, mdat]));

    expect(init.length).toBe(ftyp.length + moov.length);
    expect(init.toString('ascii', 4, 8)).toBe('ftyp');
    expect(media.toString('ascii', 4, 8)).toBe('moof');
    expect(media.length).toBe(moof.length + mdat.length);
  });

  it('treats a header-only stream as all init, which is what the init request wants', () => {
    const buffer = Buffer.concat([box('ftyp'), box('moov', 16)]);
    const { init, media } = splitFragmentedMp4(buffer);

    expect(init.length).toBe(buffer.length);
    expect(media.length).toBe(0);
  });

  it('stops rather than misreading a truncated box header', () => {
    expect(() => splitFragmentedMp4(Buffer.from([0, 0, 0]))).not.toThrow();
  });
});

describe('parseTrackTimescales', () => {
  it('reads each track id and timescale out of an init segment', () => {
    const init = buildInit([
      { trackId: 1, timescale: 16_000 },
      { trackId: 2, timescale: 44_100 }
    ]);
    expect([...parseTrackTimescales(init)]).toEqual([
      [1, 16_000],
      [2, 44_100]
    ]);
  });

  it('returns nothing rather than guessing when there is no moov', () => {
    expect(parseTrackTimescales(Buffer.alloc(0)).size).toBe(0);
  });
});

describe('offsetFragmentTimestamps', () => {
  const timescales = new Map([
    [1, 16_000],
    [2, 44_100]
  ]);

  it('shifts every fragment onto the global timeline, per track', () => {
    // ffmpeg numbers each segment from zero, so a segment cut at 7.5s arrives
    // claiming to start at 0 and has to be moved.
    const segment = buildFragment([
      { trackId: 1, baseMediaDecodeTime: 0n },
      { trackId: 2, baseMediaDecodeTime: 0n },
      { trackId: 1, baseMediaDecodeTime: 40_000n }
    ]);

    const shifted = offsetFragmentTimestamps(segment, 7500, timescales);

    expect(readTfdts(shifted)).toEqual([
      120_000n, // 7.5s × 16000
      330_750n, // 7.5s × 44100
      160_000n // relative 2.5s later, so 10s × 16000
    ]);
  });

  it('leaves the first segment alone', () => {
    const segment = buildFragment([{ trackId: 1, baseMediaDecodeTime: 0n }]);
    expect(offsetFragmentTimestamps(segment, 0, timescales)).toBe(segment);
  });

  it('leaves a track it has no timescale for untouched', () => {
    // A wrong offset would desynchronise that track; none at all is recoverable.
    const segment = buildFragment([{ trackId: 9, baseMediaDecodeTime: 5n }]);
    expect(readTfdts(offsetFragmentTimestamps(segment, 7500, timescales))).toEqual([5n]);
  });

  it('does not change the segment length, so no other offset moves', () => {
    const segment = buildFragment([{ trackId: 1, baseMediaDecodeTime: 0n }]);
    expect(offsetFragmentTimestamps(segment, 7500, timescales).length).toBe(segment.length);
  });
});

// --- box builders ----------------------------------------------------------
// Minimal but structurally real MP4 boxes, so the parsers above are exercised
// against the same nesting ffmpeg produces.

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** A version-0 full box: one version byte, three flag bytes, then `body`. */
function fullBox(type: string, body: Buffer, version = 0): Buffer {
  const head = Buffer.alloc(4);
  head[0] = version;
  return box(type, head, body);
}

function buildInit(tracks: { trackId: number; timescale: number }[]): Buffer {
  const traks = tracks.map(({ trackId, timescale }) => {
    // tkhd v0: creation(4) modification(4) track_ID(4) …
    const tkhd = Buffer.alloc(20);
    tkhd.writeUInt32BE(trackId, 8);
    // mdhd v0: creation(4) modification(4) timescale(4) …
    const mdhd = Buffer.alloc(16);
    mdhd.writeUInt32BE(timescale, 8);
    return box('trak', fullBox('tkhd', tkhd), box('mdia', fullBox('mdhd', mdhd)));
  });
  return Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', ...traks)]);
}

function buildFragment(
  trafs: { trackId: number; baseMediaDecodeTime: bigint }[]
): Buffer {
  // ffmpeg writes one moof per fragment; several fragments can share a segment.
  const built = trafs.map(({ trackId, baseMediaDecodeTime }) => {
    const tfhd = Buffer.alloc(8);
    tfhd.writeUInt32BE(trackId, 0);
    const tfdt = Buffer.alloc(8);
    tfdt.writeBigUInt64BE(baseMediaDecodeTime);
    return box('moof', box('traf', fullBox('tfhd', tfhd), fullBox('tfdt', tfdt, 1)));
  });
  return Buffer.concat([...built, box('mdat', Buffer.alloc(16))]);
}

function readTfdts(buffer: Buffer): bigint[] {
  const values: bigint[] = [];
  for (let i = 0; i + 8 <= buffer.length; i++) {
    if (buffer.toString('ascii', i, i + 4) === 'tfdt') values.push(buffer.readBigUInt64BE(i + 8));
  }
  return values;
}
