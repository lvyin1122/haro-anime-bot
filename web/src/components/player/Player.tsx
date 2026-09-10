import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, beaconProgress, type PlaybackInfo } from '../../api';
import { useT } from '../../i18n';
import { Controls, SPEEDS } from './Controls';
import { SubtitleOverlay } from './SubtitleOverlay';

/** How often a resume point is written while playing. */
const PROGRESS_INTERVAL_MS = 10_000;
/** Controls fade out after this long without a mouse move, while playing. */
const IDLE_MS = 2500;
/** Resume rather than restart only if you got meaningfully into the episode. */
const RESUME_FLOOR_MS = 15_000;

export function Player({
  info,
  onSelectAudio,
  onNext,
  hasNext
}: {
  info: PlaybackInfo;
  onSelectAudio: (index: number) => void;
  onNext?: () => void;
  hasNext: boolean;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(info.durationMs / 1000);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [subtitleId, setSubtitleId] = useState<string | null>(() => {
    const preferred =
      info.subtitleTracks.find((track) => track.isDefault && !track.forced) ??
      info.subtitleTracks[0];
    return preferred?.id ?? null;
  });
  const [subtitleScale, setSubtitleScale] = useState(1);

  const subtitle = useMemo(
    () => info.subtitleTracks.find((track) => track.id === subtitleId),
    [info.subtitleTracks, subtitleId]
  );

  // --- source ---------------------------------------------------------------

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    setError(null);

    // Direct play and Safari's native HLS both just take the URL.
    const isHls = info.streamUrl.includes('.m3u8');
    if (!isHls || element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = info.streamUrl;
      return;
    }

    let hls: { destroy: () => void } | undefined;
    let cancelled = false;

    void (async () => {
      const { default: Hls } = await import('hls.js');
      if (cancelled || !Hls.isSupported()) {
        if (!cancelled) setError(t('player.unsupported'));
        return;
      }
      const instance = new Hls({
        // Segments are produced on demand, so a slow first byte is the
        // transcoder starting up rather than a dead connection.
        manifestLoadingTimeOut: 30_000,
        fragLoadingTimeOut: 60_000,
        // Enough lookahead to ride out one slow segment without spending the
        // whole episode's CPU up front.
        maxBufferLength: 30
      });
      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) instance.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) instance.recoverMediaError();
        else setError(data.reason ?? data.details ?? 'Playback failed.');
      });
      instance.loadSource(info.streamUrl);
      instance.attachMedia(element);
      hls = instance;
    })();

    return () => {
      cancelled = true;
      hls?.destroy();
      element.removeAttribute('src');
      element.load();
    };
  }, [info.streamUrl]);

  // Offer the resume point once the browser knows how long the file is.
  const resumedRef = useRef(false);
  useEffect(() => {
    resumedRef.current = false;
  }, [info.fileId]);

  const onLoadedMetadata = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);

    if (resumedRef.current) return;
    resumedRef.current = true;

    const { positionMs, played } = info.resume;
    // Finishing an episode and opening it again means starting over, not
    // jumping to the credits.
    if (!played && positionMs > RESUME_FLOOR_MS) element.currentTime = positionMs / 1000;
  }, [info.resume]);

  // --- progress -------------------------------------------------------------

  const positionRef = useRef(0);
  positionRef.current = currentTime;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      void api
        .saveProgress(info.fileId, positionRef.current * 1000, duration * 1000)
        .catch(() => {});
    }, PROGRESS_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [playing, info.fileId, duration]);

  // Pausing and leaving are both "I stopped here"; the second needs a beacon
  // because a normal request is cancelled as the page goes away.
  useEffect(() => {
    const save = () => {
      if (positionRef.current > 0) {
        beaconProgress(info.fileId, positionRef.current * 1000, duration * 1000);
      }
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
    };
  }, [info.fileId, duration]);

  // --- element wiring -------------------------------------------------------

  const syncBuffered = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < element.buffered.length; i++) {
      ranges.push([element.buffered.start(i), element.buffered.end(i)]);
    }
    setBuffered(ranges);
  }, []);

  const seekBy = useCallback((delta: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(element.duration || Infinity, element.currentTime + delta));
  }, []);

  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void shellRef.current?.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const adjustVolume = useCallback((next: number) => {
    const element = videoRef.current;
    if (!element) return;
    const clamped = Math.max(0, Math.min(1, next));
    element.volume = clamped;
    element.muted = clamped === 0;
  }, []);

  const changeSpeed = useCallback((next: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.playbackRate = next;
  }, []);

  const stepSpeed = useCallback((direction: 1 | -1) => {
    const element = videoRef.current;
    if (!element) return;
    const index = SPEEDS.indexOf(element.playbackRate);
    const from = index === -1 ? SPEEDS.indexOf(1) : index;
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, from + direction))];
    if (next !== undefined) element.playbackRate = next;
  }, []);

  // --- keyboard -------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal keys from a text field or an open menu's controls.
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const handlers: Record<string, () => void> = {
        ' ': togglePlay,
        k: togglePlay,
        ArrowRight: () => seekBy(event.shiftKey ? 10 : 5),
        ArrowLeft: () => seekBy(event.shiftKey ? -10 : -5),
        l: () => seekBy(10),
        j: () => seekBy(-10),
        ArrowUp: () => adjustVolume((videoRef.current?.volume ?? 1) + 0.05),
        ArrowDown: () => adjustVolume((videoRef.current?.volume ?? 1) - 0.05),
        m: () => {
          const element = videoRef.current;
          if (element) element.muted = !element.muted;
        },
        f: toggleFullscreen,
        c: () =>
          setSubtitleId((current) =>
            current === null ? (info.subtitleTracks[0]?.id ?? null) : null
          ),
        ']': () => stepSpeed(1),
        '[': () => stepSpeed(-1)
      };

      const handler = handlers[event.key];
      if (!handler) return;
      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, adjustVolume, toggleFullscreen, stepSpeed, info.subtitleTracks]);

  // --- idle ----------------------------------------------------------------

  useEffect(() => {
    if (!playing) {
      setIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const shell = shellRef.current;
    shell?.addEventListener('mousemove', wake);
    shell?.addEventListener('touchstart', wake);
    return () => {
      clearTimeout(timer);
      shell?.removeEventListener('mousemove', wake);
      shell?.removeEventListener('touchstart', wake);
    };
  }, [playing]);

  return (
    <div
      ref={shellRef}
      className="group/player relative overflow-hidden rounded-xl bg-black select-none"
      style={{ cursor: idle ? 'none' : undefined }}
    >
      <video
        ref={(element) => {
          videoRef.current = element;
          setVideo(element);
        }}
        className="aspect-video max-h-[calc(100vh-12rem)] w-full bg-black"
        playsInline
        // The <video> element's own controls would fight ours, and its
        // subtitle menu cannot see the ASS tracks at all.
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onProgress={syncBuffered}
        onVolumeChange={(event) => {
          setVolume(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onRateChange={(event) => setSpeed(event.currentTarget.playbackRate)}
        onEnded={() => {
          void api.saveProgress(info.fileId, duration * 1000, duration * 1000).catch(() => {});
          if (hasNext) onNext?.();
        }}
        onError={() =>
          setError(t('player.streamRejected'))
        }
      />

      <SubtitleOverlay
        video={video}
        track={subtitle}
        fonts={info.fonts}
        fontScale={subtitleScale}
      />

      {error && (
        <div className="absolute inset-x-0 top-0 m-3 rounded-lg border border-red-900/60 bg-red-950/80 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      <div
        className="absolute inset-x-0 bottom-0 transition-opacity duration-200"
        style={{ opacity: idle ? 0 : 1, pointerEvents: idle ? 'none' : undefined }}
      >
        <Controls
          playing={playing}
          currentTime={currentTime}
          duration={duration}
          buffered={buffered}
          volume={volume}
          muted={muted}
          speed={speed}
          fullscreen={fullscreen}
          delivery={info.delivery}
          reasons={info.reasons}
          audioTracks={info.audioTracks}
          selectedAudio={info.selectedAudio}
          subtitleTracks={info.subtitleTracks}
          selectedSubtitle={subtitleId}
          subtitleScale={subtitleScale}
          hasNext={hasNext}
          onTogglePlay={togglePlay}
          onSeek={(seconds) => {
            const element = videoRef.current;
            if (element) element.currentTime = seconds;
          }}
          onVolume={adjustVolume}
          onToggleMute={() => {
            const element = videoRef.current;
            if (element) element.muted = !element.muted;
          }}
          onSpeed={changeSpeed}
          onAudio={onSelectAudio}
          onSubtitle={setSubtitleId}
          onSubtitleScale={setSubtitleScale}
          onToggleFullscreen={toggleFullscreen}
          onPictureInPicture={() => {
            const element = videoRef.current;
            if (!element) return;
            if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
            else void element.requestPictureInPicture?.().catch(() => {});
          }}
          onNext={() => onNext?.()}
        />
      </div>
    </div>
  );
}
