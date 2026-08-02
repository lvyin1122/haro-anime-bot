import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import {
  api,
  formatEpisode,
  formatRelative,
  formatSize,
  jellyfinItemUrl,
  type DownloadStatus
} from '../api';
import { Play } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Progress,
  Spinner,
  StatusBadge
} from '../components/ui';

const FILTERS: Array<{ key: string; label: string; status?: DownloadStatus[] }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active', status: ['queued', 'downloading', 'completed', 'importing'] },
  { key: 'imported', label: 'In library', status: ['imported'] },
  { key: 'failed', label: 'Failed', status: ['failed'] }
];

export function DownloadsPage() {
  const queryClient = useQueryClient();
  const [filterKey, setFilterKey] = useState('all');
  const [notice, setNotice] = useState<string>();

  const filter = FILTERS.find((f) => f.key === filterKey)!;

  const { data, isPending, error } = useQuery({
    queryKey: ['downloads', filterKey],
    queryFn: () => api.downloads(filter.status ? { status: filter.status } : {}),
    refetchInterval: 10_000
  });

  // Lets an imported row offer a direct Play link into Jellyfin.
  const ready = useQuery({ queryKey: ['ready', 100], queryFn: () => api.ready(100) });
  const playable = new Map(
    (ready.data?.items ?? [])
      .filter((item) => item.state === 'ready' && item.itemId)
      .map((item) => [item.downloadId, item])
  );

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['downloads'] });

  const refresh = useMutation({
    mutationFn: api.refreshDownloads,
    onSuccess: invalidate,
    onError: (err: Error) => setNotice(err.message)
  });

  const retry = useMutation({
    mutationFn: (id: number) => api.retryDownload(id),
    onSuccess: invalidate,
    onError: (err: Error) => setNotice(err.message)
  });

  const reimport = useMutation({
    mutationFn: (id: number) => api.reimportDownload(id),
    onSuccess: () => {
      setNotice('Re-import finished.');
      invalidate();
    },
    onError: (err: Error) => setNotice(`Import failed: ${err.message}`)
  });

  const remove = useMutation({
    mutationFn: ({ id, removeTorrent }: { id: number; removeTorrent: boolean }) =>
      api.deleteDownload(id, { removeTorrent }),
    onSuccess: invalidate,
    onError: (err: Error) => setNotice(err.message)
  });

  const rows = data?.downloads ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Downloads</h1>
        <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          <RefreshCw className={refresh.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Sync with qBittorrent
        </Button>
      </div>

      <div className="flex gap-1 border-b border-ink-800">
        {FILTERS.map((option) => (
          <button
            key={option.key}
            onClick={() => setFilterKey(option.key)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition',
              filterKey === option.key
                ? 'border-brand text-ink-100'
                : 'border-transparent text-ink-500 hover:text-ink-300'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs break-title text-ink-300">
          {notice}
        </div>
      )}

      {isPending && <Spinner />}
      {error && <ErrorNote>{(error as Error).message}</ErrorNote>}
      {!isPending && rows.length === 0 && (
        <EmptyState
          title="Nothing here"
          description="Downloads appear once a subscription picks up an episode, or when you grab a release by hand from an anime page."
        />
      )}

      <div className="space-y-1.5">
        {rows.map((download) => (
          <Card key={download.id} className="py-2.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={download.status} />
                  {download.episode !== undefined && (
                    <Badge tone="brand">
                      {formatEpisode(download.episode)}
                      {download.episodeTo ? `–${download.episodeTo}` : ''}
                    </Badge>
                  )}
                  {download.fansub && <Badge>{download.fansub}</Badge>}
                  {download.needsReview && (
                    <Badge tone="warn" title="Episode number came from the fallback parser">
                      check episode
                    </Badge>
                  )}
                  <span className="text-[11px] text-ink-500">
                    {formatSize(download.size)} · {formatRelative(download.addedAt)}
                    {download.qbState ? ` · ${download.qbState}` : ''}
                  </span>
                </div>

                <div className="break-title text-[11px] leading-snug text-ink-300">
                  {download.title}
                </div>

                {download.error && (
                  <div className="mt-1.5">
                    <ErrorNote>{download.error}</ErrorNote>
                  </div>
                )}

                {(download.status === 'downloading' || download.status === 'queued') && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Progress value={download.qbProgress} />
                    <span className="shrink-0 text-[11px] text-ink-500">
                      {Math.round(download.qbProgress * 100)}%
                    </span>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap gap-1.5">
                {playable.has(download.id) && ready.data && (
                  <a
                    href={jellyfinItemUrl(
                      ready.data.publicUrl,
                      playable.get(download.id)!.itemId!,
                      ready.data.serverId
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Button size="sm" variant="primary">
                      <Play className="size-3" /> Play
                    </Button>
                  </a>
                )}
                {download.status === 'failed' && (
                  <Button size="sm" onClick={() => retry.mutate(download.id)}>
                    Retry
                  </Button>
                )}
                {(download.status === 'failed' ||
                  download.status === 'completed' ||
                  download.status === 'imported') && (
                  <Button size="sm" onClick={() => reimport.mutate(download.id)}>
                    Import
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  title="Forget this record. The torrent stays in qBittorrent."
                  onClick={() => remove.mutate({ id: download.id, removeTorrent: false })}
                >
                  Forget
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  title="Remove from qBittorrent too. Downloaded files are kept."
                  onClick={() => {
                    if (confirm('Remove this torrent from qBittorrent? Files on disk are kept.')) {
                      remove.mutate({ id: download.id, removeTorrent: true });
                    }
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
