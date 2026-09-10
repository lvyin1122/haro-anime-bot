import { useEffect, useRef } from 'react';

import type { SubtitleTrack } from '../../api';

/**
 * Renders the selected subtitle track over the video.
 *
 * ASS is the format fansub releases actually ship, and it is not a list of
 * timed strings — it carries positioning, fades, rotation, per-line styles and
 * typeset signs that sit on top of the picture. `<track>` and WebVTT throw all
 * of that away, so ASS goes through libass (compiled to WebAssembly, via
 * JASSUB) drawing onto its own canvas, and only the plainer formats use the
 * browser's native renderer.
 *
 * JASSUB and its ~2MB of WebAssembly are imported dynamically: most sessions
 * never turn subtitles on, and nobody should pay for the download until they
 * do.
 */
export function SubtitleOverlay({
  video,
  track,
  fonts,
  fontScale
}: {
  video: HTMLVideoElement | null;
  track: SubtitleTrack | undefined;
  fonts: string[];
  fontScale: number;
}) {
  // Typed loosely on purpose: the concrete type only exists after the dynamic
  // import, and threading it through here would pull the module into the main
  // bundle just for a type annotation.
  const instance = useRef<{ destroy: () => void; resize: () => void } | null>(null);

  useEffect(() => {
    if (!video || !track || track.format !== 'ass') return;

    let cancelled = false;
    void (async () => {
      const [{ default: JASSUB }, workerUrl, wasmUrl, modernWasmUrl] = await Promise.all([
        import('jassub'),
        import('jassub/dist/wasm/jassub-worker.js?url'),
        import('jassub/dist/wasm/jassub-worker.wasm?url'),
        import('jassub/dist/wasm/jassub-worker-modern.wasm?url')
      ]);
      if (cancelled) return;

      instance.current = new JASSUB({
        video,
        subUrl: track.url,
        workerUrl: workerUrl.default,
        wasmUrl: wasmUrl.default,
        modernWasmUrl: modernWasmUrl.default,
        // Fonts attached to the Matroska file. A release's typesetting is
        // unreadable in a substitute face, and these are the ones it was made
        // with.
        fonts,
        // Reading the viewer's installed fonts needs a permission prompt and
        // tells us nothing useful: the attachments above are the fonts that
        // matter, and libass falls back sensibly without them.
        queryFonts: false
      });
    })();

    return () => {
      cancelled = true;
      instance.current?.destroy();
      instance.current = null;
    };
  }, [video, track, fonts]);

  // libass sizes text against the video's own resolution, so the only way to
  // make subtitles bigger is to lie to it about how tall the video is.
  useEffect(() => {
    const jassub = instance.current as { maxRenderHeight?: number } | null;
    if (!jassub || !video) return;
    jassub.maxRenderHeight = Math.round((video.videoHeight || 1080) / fontScale);
    instance.current?.resize();
  }, [fontScale, video, track]);

  if (!video || !track || track.format === 'ass') return null;

  // WebVTT needs no canvas — the browser draws it, given a <track> on the
  // video element. Rendered as a portal-free sibling would not work, so it is
  // attached imperatively instead.
  return <NativeTrack video={video} track={track} />;
}

/**
 * Attach a WebVTT track to the video element.
 *
 * React cannot render `<track>` into a `<video>` it does not own, and the
 * player owns the element, so this adds and removes the node directly.
 */
function NativeTrack({ video, track }: { video: HTMLVideoElement; track: SubtitleTrack }) {
  useEffect(() => {
    const element = document.createElement('track');
    element.kind = 'subtitles';
    element.label = track.label;
    if (track.language) element.srclang = track.language;
    element.src = track.url;
    element.default = true;
    video.appendChild(element);

    // The mode has to be set after the browser has adopted the track.
    const show = () => {
      const textTrack = element.track;
      if (textTrack) textTrack.mode = 'showing';
    };
    element.addEventListener('load', show);
    show();

    return () => {
      element.removeEventListener('load', show);
      element.remove();
    };
  }, [video, track]);

  return null;
}
