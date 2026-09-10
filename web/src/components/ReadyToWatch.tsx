import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import clsx from 'clsx';
import { CheckCircle2, Clock, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import {
  api,
  formatEpisode,
  jellyfinItemUrl,
  type ReadyItem,
  type ReadyResponse
} from '../api';
import { useRelativeTime, useT } from '../i18n';
import { Badge, Button, Card, EmptyState, ErrorNote, Spinner } from './ui';

/** "Resume" only once you are far enough in for it to be worth saying. */
function isPartlyWatched(item: ReadyItem): boolean {
  return (
    item.playedPercentage !== undefined &&
    item.playedPercentage > 1 &&
    item.playedPercentage < 95
  );
}

function PlayButton({
  item,
  data,
  size = 'md'
}: {
  item: ReadyItem;
  data: ReadyResponse;
  size?: 'sm' | 'md';
}) {
  const t = useT();
  const label = isPartlyWatched(item) ? t('common.resume') : t('common.play');

  if (item.state !== 'ready') {
    return (
      <Badge
        tone="warn"
        title={
          data.playerMode === 'builtin'
            ? t('ready.tooltipFileMissing')
            : t('ready.tooltipPendingScan')
        }
      >
        <Clock className="mr-1 size-3" />
        {data.playerMode === 'builtin' ? t('ready.badgeFileMissing') : t('ready.badgePendingScan')}
      </Badge>
    );
  }

  // The built-in player opens in the app; Jellyfin is a deep link out to it.
  if (data.playerMode === 'builtin') {
    if (item.fileId === undefined) return null;
    return (
      <Link to="/watch/$fileId" params={{ fileId: String(item.fileId) }}>
        <Button variant="primary" size={size}>
          <Play className="size-3.5" />
          {label}
        </Button>
      </Link>
    );
  }

  if (!item.itemId) {
    return (
      <Badge tone="warn" title={t('ready.tooltipPendingScan')}>
        <Clock className="mr-1 size-3" />
        {t('ready.badgePendingScan')}
      </Badge>
    );
  }

  return (
    <a href={jellyfinItemUrl(data.publicUrl, item.itemId, data.serverId)} target="_blank" rel="noreferrer">
      <Button variant="primary" size={size}>
        <Play className="size-3.5" />
        {label}
      </Button>
    </a>
  );
}

export function ReadyRow({ item, data }: { item: ReadyItem; data: ReadyResponse }) {
  const t = useT();
  const relative = useRelativeTime();
  return (
    <Card className="py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge tone="brand">
              S{String(item.season).padStart(2, '0')}
              {formatEpisode(item.episode)}
            </Badge>
            {item.played ? (
              <Badge tone="neutral" title={t('common.watched')}>
                <CheckCircle2 className="mr-1 size-3" />
                {t('common.watched')}
              </Badge>
            ) : (
              <Badge tone="success">{t('common.new')}</Badge>
            )}
            {item.importedAt && (
              <span className="text-[11px] text-ink-500">
                {t('ready.addedAt', { when: relative(item.importedAt) })}
              </span>
            )}
          </div>

          <div className="truncate text-sm font-medium">
            {item.subscriptionId ? (
              <Link
                to="/subscriptions/$id"
                params={{ id: String(item.subscriptionId) }}
                className="hover:text-brand"
              >
                {item.seriesTitle}
              </Link>
            ) : (
              item.seriesTitle
            )}
          </div>

          {item.episodeTitle && (
            <div className="truncate text-[11px] text-ink-500">{item.episodeTitle}</div>
          )}

          {isPartlyWatched(item) && (
            <div className="mt-1.5 h-1 w-40 overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full rounded-full bg-brand"
                style={{ width: `${item.playedPercentage}%` }}
              />
            </div>
          )}
        </div>

        <PlayButton item={item} data={data} />
      </div>
    </Card>
  );
}

export function ReadyToWatch({
  limit = 40,
  compact = false
}: {
  limit?: number;
  compact?: boolean;
}) {
  const t = useT();
  const relative = useRelativeTime();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const [showWatched, setShowWatched] = useState(false);

  const { data, isPending, error } = useQuery({
    queryKey: ['ready', limit],
    queryFn: () => api.ready(limit),
    refetchInterval: 60_000
  });

  const rescan = useMutation({
    mutationFn: api.rescanLibrary,
    onSuccess: (result) => {
      setNotice(result.detail);
      // The scan is asynchronous inside Jellyfin, so give it a moment before
      // re-checking rather than immediately reporting the same pending state.
      setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['ready'] }), 8000);
    },
    onError: (err: Error) => setNotice(err.message)
  });

  if (isPending) return <Spinner label={t('ready.checking')} />;
  if (error) return <ErrorNote>{(error as Error).message}</ErrorNote>;
  if (!data) return null;

  const all = data.items;
  const unwatched = all.filter((item) => !item.played);
  const visible = showWatched ? all : unwatched;
  const shown = compact ? visible.slice(0, 5) : visible;
  const pending = all.filter((item) => item.state !== 'ready').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">{t('ready.title')}</h2>
          {unwatched.length > 0 && (
            <Badge tone="success">{t('ready.newCount', { count: unwatched.length })}</Badge>
          )}
          {pending > 0 && (
            <Badge
              tone="warn"
              title={
                data.playerMode === 'builtin'
                  ? t('ready.missingHint')
                  : t('ready.pendingScanHint')
              }
            >
              {data.playerMode === 'builtin'
                ? t('ready.missing', { count: pending })
                : t('ready.pendingScan', { count: pending })}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {all.length > unwatched.length && (
            <button
              onClick={() => setShowWatched((value) => !value)}
              className="text-[11px] text-ink-500 hover:text-ink-300"
            >
              {showWatched
                ? t('ready.hideWatched')
                : t('ready.showWatched', { count: all.length - unwatched.length })}
            </button>
          )}
          {compact ? (
            <Link to="/library" className="text-xs text-brand hover:underline">
              {t('common.seeAll')}
            </Link>
          ) : (
            // Only Jellyfin needs telling that a file appeared; the built-in
            // player reads the library directly.
            data.playerMode === 'jellyfin' && (
              <Button size="sm" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
                <RefreshCw className={clsx('size-3', rescan.isPending && 'animate-spin')} />
                {t('ready.rescan')}
              </Button>
            )
          )}
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-ink-300">
          {notice}
        </div>
      )}

      {data.error && <ErrorNote>{data.error}</ErrorNote>}

      {data.playerMode === 'jellyfin' && !data.jellyfinConfigured && (
        <ErrorNote>
          {t('ready.jellyfinUnconfigured')}
        </ErrorNote>
      )}

      {shown.length === 0 && (
        <EmptyState
          title={all.length === 0 ? t('ready.emptyTitle') : t('ready.caughtUp')}
          description={
            all.length === 0 ? t('ready.emptyHint') : t('ready.caughtUpHint')
          }
        />
      )}

      <div className="space-y-1.5">
        {shown.map((item) => (
          <ReadyRow key={item.downloadId} item={item} data={data} />
        ))}
      </div>
    </div>
  );
}
