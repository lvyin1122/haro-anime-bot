import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import clsx from 'clsx';
import { CheckCircle2, Clock, Play, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import {
  api,
  formatEpisode,
  formatRelative,
  jellyfinItemUrl,
  type ReadyItem,
  type ReadyResponse
} from '../api';
import { Badge, Button, Card, EmptyState, ErrorNote, Spinner } from './ui';

function PlayButton({
  item,
  data,
  size = 'md'
}: {
  item: ReadyItem;
  data: ReadyResponse;
  size?: 'sm' | 'md';
}) {
  if (item.state !== 'ready' || !item.itemId) {
    return (
      <Badge tone="warn" title="The file is in your library; Jellyfin has not indexed it yet.">
        <Clock className="mr-1 size-3" />
        pending scan
      </Badge>
    );
  }

  const href = jellyfinItemUrl(data.publicUrl, item.itemId, data.serverId);

  return (
    <a href={href} target="_blank" rel="noreferrer">
      <Button variant="primary" size={size}>
        <Play className="size-3.5" />
        {item.playedPercentage && item.playedPercentage > 1 && item.playedPercentage < 95
          ? 'Resume'
          : 'Play'}
      </Button>
    </a>
  );
}

export function ReadyRow({ item, data }: { item: ReadyItem; data: ReadyResponse }) {
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
              <Badge tone="neutral" title="Already watched in Jellyfin">
                <CheckCircle2 className="mr-1 size-3" />
                watched
              </Badge>
            ) : (
              <Badge tone="success">new</Badge>
            )}
            {item.importedAt && (
              <span className="text-[11px] text-ink-500">
                added {formatRelative(item.importedAt)}
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

          {item.playedPercentage !== undefined &&
            item.playedPercentage > 1 &&
            item.playedPercentage < 95 && (
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

  if (isPending) return <Spinner label="Checking your library…" />;
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
          <h2 className="text-sm font-semibold">Ready to watch</h2>
          {unwatched.length > 0 && <Badge tone="success">{unwatched.length} new</Badge>}
          {pending > 0 && (
            <Badge tone="warn" title="Imported but not yet indexed by Jellyfin">
              {pending} pending scan
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {all.length > unwatched.length && (
            <button
              onClick={() => setShowWatched((value) => !value)}
              className="text-[11px] text-ink-500 hover:text-ink-300"
            >
              {showWatched ? 'Hide watched' : `Show watched (${all.length - unwatched.length})`}
            </button>
          )}
          {compact ? (
            <Link to="/library" className="text-xs text-brand hover:underline">
              See all →
            </Link>
          ) : (
            <Button size="sm" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
              <RefreshCw className={clsx('size-3', rescan.isPending && 'animate-spin')} />
              Rescan Jellyfin
            </Button>
          )}
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-ink-300">
          {notice}
        </div>
      )}

      {data.error && <ErrorNote>{data.error}</ErrorNote>}

      {!data.jellyfinConfigured && (
        <ErrorNote>
          Set JELLYFIN_API_KEY and JELLYFIN_USER_ID to link imported episodes to Jellyfin. The files
          are in your library either way.
        </ErrorNote>
      )}

      {shown.length === 0 && (
        <EmptyState
          title={all.length === 0 ? 'Nothing in your library yet' : 'All caught up'}
          description={
            all.length === 0
              ? 'Once a subscription downloads an episode and files it into Jellyfin, it shows up here with a play link.'
              : 'Every downloaded episode has been watched.'
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
