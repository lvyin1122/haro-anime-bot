import clsx from 'clsx';
import {
  Captions,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import type { AudioTrack, Delivery, SubtitleTrack } from '../../api';

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
export const SUBTITLE_SCALES = [0.75, 1, 1.25, 1.5, 2];

const DELIVERY_LABEL: Record<Delivery, string> = {
  direct: 'Direct play',
  remux: 'Repackaging',
  transcode: 'Transcoding'
};

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

/** A popover anchored to its trigger. Closes on outside click or Escape. */
function Menu({
  icon,
  label,
  active,
  children
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stop the player's own Escape handling from also leaving fullscreen.
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={container}>
      <ControlButton label={label} onClick={() => setOpen((value) => !value)} active={active || open}>
        {icon}
      </ControlButton>
      {open && (
        <div className="absolute right-0 bottom-full mb-2 min-w-52 rounded-xl border border-ink-700 bg-ink-950/95 p-1.5 shadow-2xl backdrop-blur">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-ink-500 uppercase">
      {children}
    </div>
  );
}

function MenuItem({
  children,
  selected,
  onClick
}: {
  children: ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs transition',
        selected ? 'bg-brand/20 text-brand' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
      )}
    >
      <span className="truncate">{children}</span>
      {selected && <span aria-hidden>✓</span>}
    </button>
  );
}

function ControlButton({
  children,
  label,
  onClick,
  active
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'inline-flex size-9 items-center justify-center rounded-lg transition',
        active ? 'text-brand' : 'text-ink-100 hover:bg-white/10'
      )}
    >
      {children}
    </button>
  );
}

export interface ControlsProps {
  playing: boolean;
  currentTime: number;
  duration: number;
  buffered: Array<[number, number]>;
  volume: number;
  muted: boolean;
  speed: number;
  fullscreen: boolean;
  delivery: Delivery;
  reasons: string[];
  audioTracks: AudioTrack[];
  selectedAudio: number | null;
  subtitleTracks: SubtitleTrack[];
  selectedSubtitle: string | null;
  subtitleScale: number;
  hasNext: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onSpeed: (speed: number) => void;
  onAudio: (index: number) => void;
  onSubtitle: (id: string | null) => void;
  onSubtitleScale: (scale: number) => void;
  onToggleFullscreen: () => void;
  onPictureInPicture: () => void;
  onNext: () => void;
}

export function Controls(props: ControlsProps) {
  const {
    playing,
    currentTime,
    duration,
    buffered,
    volume,
    muted,
    speed,
    fullscreen,
    delivery,
    reasons,
    audioTracks,
    selectedAudio,
    subtitleTracks,
    selectedSubtitle,
    subtitleScale,
    hasNext
  } = props;

  const scrubberId = useId();
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="bg-gradient-to-t from-black/90 via-black/70 to-transparent px-3 pt-8 pb-2 sm:px-4">
      {/* Scrubber. The buffered ranges sit behind the played portion so it is
          obvious whether a stall is the network or the transcoder. */}
      <div className="group/scrub relative h-6">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/20">
          {buffered.map(([start, end], index) => (
            <div
              key={index}
              className="absolute inset-y-0 bg-white/30"
              style={{
                left: `${duration > 0 ? (start / duration) * 100 : 0}%`,
                width: `${duration > 0 ? ((end - start) / duration) * 100 : 0}%`
              }}
            />
          ))}
          <div className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${progress}%` }} />
        </div>
        <input
          id={scrubberId}
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          aria-label="Seek"
          onChange={(event) => props.onSeek(Number(event.target.value))}
          className="absolute inset-x-0 top-1/2 h-6 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent
                     [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none
                     [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand
                     [&::-webkit-slider-thumb]:opacity-0 group-hover/scrub:[&::-webkit-slider-thumb]:opacity-100
                     [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none
                     [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-brand"
        />
      </div>

      <div className="flex items-center gap-1">
        <ControlButton label={playing ? 'Pause' : 'Play'} onClick={props.onTogglePlay}>
          {playing ? <Pause className="size-5" /> : <Play className="size-5" />}
        </ControlButton>

        {hasNext && (
          <ControlButton label="Next episode" onClick={props.onNext}>
            <SkipForward className="size-4.5" />
          </ControlButton>
        )}

        <div className="group/vol flex items-center">
          <ControlButton label={muted ? 'Unmute' : 'Mute'} onClick={props.onToggleMute}>
            {muted || volume === 0 ? <VolumeX className="size-4.5" /> : <Volume2 className="size-4.5" />}
          </ControlButton>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={muted ? 0 : volume}
            aria-label="Volume"
            onChange={(event) => props.onVolume(Number(event.target.value))}
            className="h-1 w-0 cursor-pointer appearance-none rounded-full bg-white/25 opacity-0 transition-all
                       group-hover/vol:mr-2 group-hover/vol:w-20 group-hover/vol:opacity-100
                       focus:mr-2 focus:w-20 focus:opacity-100
                       [&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none
                       [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
                       [&::-moz-range-thumb]:size-2.5 [&::-moz-range-thumb]:appearance-none
                       [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
          />
        </div>

        <div className="ml-1 font-mono text-[11px] text-ink-300 tabular-nums">
          {formatTime(currentTime)} <span className="text-ink-500">/ {formatTime(duration)}</span>
        </div>

        <div className="flex-1" />

        <span
          title={reasons.length > 0 ? reasons.join('\n') : 'Played straight from the file'}
          className={clsx(
            'mr-1 hidden rounded-md px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex',
            delivery === 'direct' && 'bg-brand/15 text-brand',
            delivery === 'remux' && 'bg-ink-800 text-ink-300',
            delivery === 'transcode' && 'bg-eye/15 text-eye'
          )}
        >
          {DELIVERY_LABEL[delivery]}
        </span>

        {audioTracks.length > 1 && (
          <Menu icon={<Volume2 className="size-4.5" />} label="Audio track">
            {(close) => (
              <>
                <MenuHeading>Audio</MenuHeading>
                {audioTracks.map((audio) => (
                  <MenuItem
                    key={audio.index}
                    selected={audio.index === selectedAudio}
                    onClick={() => {
                      props.onAudio(audio.index);
                      close();
                    }}
                  >
                    {audio.label}
                    {audio.channels && audio.channels > 2 ? ` · ${audio.channels}ch` : ''}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        )}

        <Menu
          icon={<Captions className="size-4.5" />}
          label="Subtitles"
          active={selectedSubtitle !== null}
        >
          {(close) => (
            <>
              <MenuHeading>Subtitles</MenuHeading>
              <MenuItem
                selected={selectedSubtitle === null}
                onClick={() => {
                  props.onSubtitle(null);
                  close();
                }}
              >
                Off
              </MenuItem>
              {subtitleTracks.map((subtitle) => (
                <MenuItem
                  key={subtitle.id}
                  selected={subtitle.id === selectedSubtitle}
                  onClick={() => {
                    props.onSubtitle(subtitle.id);
                    close();
                  }}
                >
                  {subtitle.label}
                  {subtitle.forced ? ' · forced' : ''}
                </MenuItem>
              ))}
              {subtitleTracks.length === 0 && (
                <div className="px-2.5 py-1.5 text-xs text-ink-500">
                  This release has no text subtitles.
                </div>
              )}
              {subtitleTracks.length > 0 && (
                <>
                  <MenuHeading>Size</MenuHeading>
                  <div className="flex gap-1 px-1.5 pb-1">
                    {SUBTITLE_SCALES.map((scale) => (
                      <button
                        key={scale}
                        type="button"
                        onClick={() => props.onSubtitleScale(scale)}
                        className={clsx(
                          'flex-1 rounded-md px-1 py-1 text-[11px] transition',
                          scale === subtitleScale
                            ? 'bg-brand/20 text-brand'
                            : 'text-ink-300 hover:bg-ink-800'
                        )}
                      >
                        {scale}×
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </Menu>

        <Menu icon={<Gauge className="size-4.5" />} label="Playback speed" active={speed !== 1}>
          {(close) => (
            <>
              <MenuHeading>Speed</MenuHeading>
              {SPEEDS.map((value) => (
                <MenuItem
                  key={value}
                  selected={value === speed}
                  onClick={() => {
                    props.onSpeed(value);
                    close();
                  }}
                >
                  {value === 1 ? 'Normal' : `${value}×`}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>

        <ControlButton label="Picture in picture" onClick={props.onPictureInPicture}>
          <PictureInPicture2 className="size-4.5" />
        </ControlButton>

        <ControlButton
          label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={props.onToggleFullscreen}
        >
          {fullscreen ? <Minimize className="size-4.5" /> : <Maximize className="size-4.5" />}
        </ControlButton>
      </div>
    </div>
  );
}
