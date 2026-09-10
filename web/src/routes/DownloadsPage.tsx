import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import clsx from 'clsx';
import { Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  api,
  formatEpisode,
  formatSize,
  playTarget,
  type DownloadStatus,
  type ReadyItem,
  type ReadyResponse
} from '../api';
import { useRelativeTime, useT } from '../i18n';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Poster,
  Progress,
  Spinner,
  StatusBadge
} from '../components/ui';

/**
 * How often the page asks the server to re-poll qBittorrent.
 *
 * The server's own monitor runs on MONITOR_INTERVAL_SECONDS (60s by default),
 * which is fine for catching completions but makes a progress bar jump in
 * minute-long steps while you are watching it. This only runs while something
 * is actually downloading, so an idle page costs nothing.
 */
const AUTO_REFRESH_MS = 5000;
const AUTO_REFRESH_KEY = 'haro.downloads.autoRefresh';

const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'downloading', 'completed', 'importing'];

const FILTERS: Array<{ key: string; labelKey: Parameters<ReturnType<typeof useT>>[0]; status?: DownloadStatus[] }> = [
  { key: 'all', labelKey: 'downloads.filter.all' },
  { key: 'active', labelKey: 'downloads.filter.active', status: ACTIVE_STATUSES },
  { key: 'imported', labelKey: 'downloads.filter.imported', status: ['imported'] },
  { key: 'failed', labelKey: 'downloads.filter.failed', status: ['failed'] }
];

/** Play button for a download row, in whichever mode this instance is in. */
function PlayLink({ item, data }: { item?: ReadyItem; data?: ReadyResponse }) {
  const t = useT();
  const target = item && data ? playTarget(data, item) : undefined;
  if (!target) return null;

  const button = (
    <Button size="sm" variant="primary">
      <Play className="size-3" /> {t('common.play')}
    </Button>
  );

  return target.internal ? (
    <Link to="/watch/$fileId" params={{ fileId: String(target.fileId) }}>
      {button}
    </Link>
  ) : (
    <a href={target.href} target="_blank" rel="noreferrer">
      {button}
    </a>
  );
}

/** Remembered across visits; falls back to on when storage is unavailable. */
function useAutoRefreshPreference(): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(AUTO_REFRESH_KEY) !== 'off';
    } catch {
      return true;
    }
  });

  return [
    enabled,
    (value: boolean) => {
      setEnabled(value);
      try {
        localStorage.setItem(AUTO_REFRESH_KEY, value ? 'on' : 'off');
      } catch {
        // Applies to this tab regardless; it just will not be remembered.
      }
    }
  ];
}

export function DownloadsPage() {
  const t = useT();
  const relative = useRelativeTime();
  const queryClient = useQueryClient();
  const [filterKey, setFilterKey] = useState('all');
  const [notice, setNotice] = useState<string>();
  const [autoRefresh, setAutoRefresh] = useAutoRefreshPreference();
  const [syncedAt, setSyncedAt] = useState<number>();

  const filter = FILTERS.find((f) => f.key === filterKey)!;

  const { data, isPending, error } = useQuery({
    queryKey: ['downloads', filterKey],
    queryFn: () => api.downloads(filter.status ? { status: filter.status } : {}),
    refetchInterval: 10_000
  });

  // Lets an imported row offer a Play button without leaving this page.
  const ready = useQuery({ queryKey: ['ready', 100], queryFn: () => api.ready(100) });
  const playable = new Map(
    (ready.data?.items ?? [])
      .filter((item) => item.state === 'ready')
      .map((item) => [item.downloadId, item] as const)
  );

  // Cover art comes from the subscription a download belongs to.
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions });
  const posters = useMemo(() => {
    const map = new Map<number, string>();
    for (const s of subs.data?.subscriptions ?? []) if (s.poster) map.set(s.id, s.poster);
    return map;
  }, [subs.data]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['downloads'] });

  const refresh = useMutation({
    mutationFn: api.refreshDownloads,
    onSuccess: () => {
      setSyncedAt(Date.now());
      invalidate();
    },
    onError: (err: Error) => setNotice(err.message)
  });

  const rows = data?.downloads ?? [];
  const active = rows.filter((d) => ACTIVE_STATUSES.includes(d.status)).length;

  // Poll only while there is something to poll about, and never stack a second
  // request on top of one still in flight.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!autoRefresh || active === 0) return;
    const timer = setInterval(() => {
      if (!refreshRef.current.isPending) refreshRef.current.mutate();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, active]);

  const retry = useMutation({
    mutationFn: (id: number) => api.retryDownload(id),
    onSuccess: invalidate,
    onError: (err: Error) => setNotice(err.message)
  });

  const reimport = useMutation({
    mutationFn: (id: number) => api.reimportDownload(id),
    onSuccess: () => {
      setNotice(t('downloads.reimportDone'));
      invalidate();
    },
    onError: (err: Error) => setNotice(t('downloads.importFailed', { error: err.message }))
  });

  const remove = useMutation({
    mutationFn: ({ id, removeTorrent }: { id: number; removeTorrent: boolean }) =>
      api.deleteDownload(id, { removeTorrent }),
    onSuccess: invalidate,
    onError: (err: Error) => setNotice(err.message)
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t('downloads.title')}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-300 select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
              className="size-3.5 accent-[var(--color-brand)]"
            />
            {t('downloads.autoRefresh')}
          </label>
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw className={clsx('size-3.5', refresh.isPending && 'animate-spin')} />
            {t('downloads.syncNow')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
        <span>
          {!autoRefresh
            ? t('downloads.autoRefreshOffHint', { seconds: 60 })
            : active === 0
              ? t('downloads.autoRefreshIdle')
              : t('downloads.autoRefreshOnHint', { seconds: AUTO_REFRESH_MS / 1000 })}
        </span>
        {syncedAt && <span>· {t('downloads.updatedAt', { when: relative(syncedAt) })}</span>}
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
            {t(option.labelKey)}
          </button>
        ))}
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs break-title text-ink-300">
          {notice}
        </div>
      )}

      {isPending && <Spinner label={t('common.loading')} />}
      {error && <ErrorNote>{(error as Error).message}</ErrorNote>}
      {!isPending && rows.length === 0 && (
        <EmptyState title={t('downloads.emptyTitle')} description={t('downloads.emptyHint')} />
      )}

      <div className="space-y-1.5">
        {rows.map((download) => (
          <Card key={download.id} className="py-2.5">
            <div className="flex gap-3">
              <Poster
                src={
                  download.subscriptionId === undefined
                    ? undefined
                    : posters.get(download.subscriptionId)
                }
                alt=""
                className="hidden h-20 w-14 shrink-0 sm:block"
              />

              <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
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
                      <Badge tone="warn" title={t('downloads.checkEpisodeHint')}>
                        {t('downloads.checkEpisode')}
                      </Badge>
                    )}
                    <span className="text-[11px] text-ink-500">
                      {formatSize(download.size)} · {relative(download.addedAt)}
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
                      <span className="shrink-0 text-[11px] text-ink-500 tabular-nums">
                        {Math.round(download.qbProgress * 100)}%
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <PlayLink item={playable.get(download.id)} data={ready.data} />
                  {download.status === 'failed' && (
                    <Button size="sm" onClick={() => retry.mutate(download.id)}>
                      {t('common.retry')}
                    </Button>
                  )}
                  {(download.status === 'failed' ||
                    download.status === 'completed' ||
                    download.status === 'imported') && (
                    <Button size="sm" onClick={() => reimport.mutate(download.id)}>
                      {t('downloads.import')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('downloads.forgetHint')}
                    onClick={() => remove.mutate({ id: download.id, removeTorrent: false })}
                  >
                    {t('downloads.forget')}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    title={t('downloads.removeHint')}
                    onClick={() => {
                      if (confirm(t('downloads.confirmRemoveTorrent'))) {
                        remove.mutate({ id: download.id, removeTorrent: true });
                      }
                    }}
                  >
                    {t('downloads.remove')}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
