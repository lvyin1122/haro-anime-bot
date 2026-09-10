import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useMemo, useState } from 'react';

import { api, formatEpisode, type ReadyItem } from '../api';
import { useT } from '../i18n';
import { browserCapabilities } from '../components/player/capabilities';
import { Player } from '../components/player/Player';
import { Badge, Button, Card, ErrorNote, Spinner } from '../components/ui';

export function WatchPage() {
  const t = useT();
  const { fileId } = useParams({ from: '/watch/$fileId' });
  const id = Number(fileId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Changing the audio track changes the plan, so it is part of the query key
  // rather than something the player fixes up locally.
  const [audioTrack, setAudioTrack] = useState<number | undefined>(undefined);
  const caps = browserCapabilities();

  const playback = useQuery({
    queryKey: ['playback', id, caps, audioTrack],
    queryFn: () => api.playbackInfo(id, caps, audioTrack),
    // The plan depends only on the file and this browser; nothing about it
    // goes stale while you are watching.
    staleTime: Infinity,
    retry: 0
  });

  // The library list is already cached by the page you came from, and is what
  // tells us which episode is next.
  const library = useQuery({ queryKey: ['ready', 100], queryFn: () => api.ready(100) });

  const info = playback.data;

  const next = useMemo(() => {
    if (!info || !library.data) return undefined;
    const sameSeries = library.data.items
      .filter(
        (item): item is ReadyItem & { fileId: number } =>
          item.fileId !== undefined &&
          item.subscriptionId === info.subscriptionId &&
          item.season === info.season
      )
      .sort((a, b) => a.episode - b.episode);
    if (info.episode === null) return undefined;
    return sameSeries.find((item) => item.episode > info.episode!);
  }, [info, library.data]);

  if (playback.isPending) {
    return (
      <Card>
        <Spinner label={t('watch.preparing')} />
      </Card>
    );
  }

  if (playback.isError || !info) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorNote>
          {playback.error instanceof Error ? playback.error.message : t('watch.failed')}
        </ErrorNote>
        <p className="text-xs text-ink-500">
          {t('watch.failedHint')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <BackLink />
          <h1 className="mt-1 truncate text-lg font-semibold break-title">{info.seriesTitle}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-500">
            <Badge tone="brand">
              S{String(info.season).padStart(2, '0')}
              {formatEpisode(info.episode ?? undefined)}
            </Badge>
            {info.width && info.height && (
              <span>
                {info.width}×{info.height}
              </span>
            )}
            {info.resume.played && <Badge tone="success">{t('common.watched')}</Badge>}
          </div>
        </div>

        {info.subscriptionId !== null && (
          <Link to="/subscriptions/$id" params={{ id: String(info.subscriptionId) }}>
            <Button variant="ghost" size="sm">
              <ExternalLink className="size-3.5" />
              {t('watch.allEpisodes')}
            </Button>
          </Link>
        )}
      </div>

      <Player
        key={`${info.fileId}:${info.selectedAudio}`}
        info={info}
        hasNext={Boolean(next)}
        onSelectAudio={setAudioTrack}
        onNext={() => {
          if (!next) return;
          // The list drives the "watched" badges, so refresh it on the way out.
          void queryClient.invalidateQueries({ queryKey: ['ready'] });
          void navigate({ to: '/watch/$fileId', params: { fileId: String(next.fileId) } });
        }}
      />

      {info.reasons.length > 0 && (
        <Card className="text-xs text-ink-500">
          <div className="mb-1 font-medium text-ink-300">
            {info.delivery === 'transcode'
              ? t('watch.transcodingTitle')
              : t('watch.remuxingTitle')}
          </div>
          <ul className="list-inside list-disc space-y-0.5">
            {info.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {info.delivery === 'transcode' && (
            <p className="mt-2">
              {t('watch.transcodingCost')}
            </p>
          )}
        </Card>
      )}

      <details className="text-xs text-ink-500">
        <summary className="cursor-pointer select-none hover:text-ink-300">
          {t('watch.shortcuts')}
        </summary>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono">
          {[
            ['space / k', t('watch.shortcut.playPause')],
            ['← / →', t('watch.shortcut.seek5')],
            ['shift + ← / →', t('watch.shortcut.seek10')],
            ['↑ / ↓', t('watch.shortcut.volume')],
            ['m', t('watch.shortcut.mute')],
            ['c', t('watch.shortcut.subtitles')],
            ['[ / ]', t('watch.shortcut.speed')],
            ['f', t('watch.shortcut.fullscreen')]
          ].map(([keys, meaning]) => (
            <div key={keys} className="contents">
              <dt className="text-ink-300">{keys}</dt>
              <dd className="font-sans">{meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link to="/library" className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-300">
      <ArrowLeft className="size-3.5" />
      {t('watch.back')}
    </Link>
  );
}
