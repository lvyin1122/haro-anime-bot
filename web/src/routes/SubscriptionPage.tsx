import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import clsx from 'clsx';
import { useState } from 'react';
import { History, Pencil, RefreshCw, Trash2 } from 'lucide-react';

import {
  api,
  formatEpisode,
  formatRelative,
  formatSize,
  playTarget,
  type PlayTarget,
  type EpisodeSlot
} from '../api';
import { SubscribeDialog } from '../components/SubscribeDialog';
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Progress,
  Spinner,
  StatusBadge
} from '../components/ui';

/** Green: in the library. Amber: on its way. Red: went wrong. Grey: nothing yet. */
const SLOT_STYLE: Record<string, string> = {
  imported: 'border-brand-soft bg-brand/20 text-brand',
  downloading: 'border-eye/50 bg-eye/15 text-eye',
  queued: 'border-eye/30 bg-eye/10 text-eye',
  completed: 'border-eye/30 bg-eye/10 text-eye',
  importing: 'border-eye/30 bg-eye/10 text-eye',
  failed: 'border-red-800/60 bg-red-500/10 text-red-300',
  skipped: 'border-ink-700 bg-ink-800/60 text-ink-500',
  missing: 'border-ink-800 bg-ink-900 text-ink-500'
};

function EpisodeCell({ slot, target }: { slot: EpisodeSlot; target?: PlayTarget }) {
  const unaired = slot.status === 'missing' && !slot.aired;
  const className = clsx(
    'block rounded-lg border px-2 py-1.5 text-center text-xs font-medium',
    unaired ? 'border-dashed border-ink-800 bg-transparent text-ink-700' : SLOT_STYLE[slot.status]
  );

  const title = `E${slot.ep} · ${slot.title}\n${slot.airdate ?? 'TBA'} · ${slot.status}${
    target ? '\nClick to play' : ''
  }`;

  // An imported episode doubles as its own play link.
  if (target?.internal) {
    return (
      <Link
        to="/watch/$fileId"
        params={{ fileId: String(target.fileId) }}
        title={title}
        className={clsx(className, 'transition hover:brightness-150')}
      >
        {slot.ep}
      </Link>
    );
  }

  if (target) {
    return (
      <a
        href={target.href}
        target="_blank"
        rel="noreferrer"
        title={title}
        className={clsx(className, 'transition hover:brightness-150')}
      >
        {slot.ep}
      </a>
    );
  }

  return (
    <div title={title} className={className}>
      {slot.ep}
    </div>
  );
}

export function SubscriptionPage() {
  const { id } = useParams({ from: '/subscriptions/$id' });
  const subscriptionId = Number(id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string>();

  const detail = useQuery({
    queryKey: ['subscription', subscriptionId],
    queryFn: () => api.subscription(subscriptionId),
    refetchInterval: 15_000
  });

  const episodes = useQuery({
    queryKey: ['subscription-episodes', subscriptionId],
    queryFn: () => api.subscriptionEpisodes(subscriptionId),
    refetchInterval: 30_000
  });

  const ready = useQuery({ queryKey: ['ready', 100], queryFn: () => api.ready(100) });

  // Episode number → where its Play link goes, for this subscription only.
  const playTargets = new Map<number, PlayTarget>();
  if (ready.data) {
    for (const item of ready.data.items) {
      if (item.subscriptionId !== subscriptionId) continue;
      const target = playTarget(ready.data, item);
      if (target) playTargets.set(Math.floor(item.episode), target);
    }
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['subscription', subscriptionId] });
    void queryClient.invalidateQueries({ queryKey: ['subscription-episodes', subscriptionId] });
    void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    void queryClient.invalidateQueries({ queryKey: ['downloads'] });
  };

  const scan = useMutation({
    mutationFn: (backfill: boolean) => api.scanSubscription(subscriptionId, backfill),
    onSuccess: ({ result }) => {
      setNotice(
        `Found ${result.found} release(s), queued ${result.queued}, skipped ${result.skipped}.` +
          (result.errors.length ? ` Errors: ${result.errors.join('; ')}` : '')
      );
      invalidate();
    },
    onError: (err: Error) => setNotice(`Scan failed: ${err.message}`)
  });

  const remove = useMutation({
    mutationFn: () => api.deleteSubscription(subscriptionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void navigate({ to: '/subscriptions' });
    }
  });

  const retry = useMutation({
    mutationFn: (downloadId: number) => api.retryDownload(downloadId),
    onSuccess: invalidate,
    onError: (err: Error) => setNotice(err.message)
  });

  const reimport = useMutation({
    mutationFn: (downloadId: number) => api.reimportDownload(downloadId),
    onSuccess: () => {
      setNotice('Re-import finished.');
      invalidate();
    },
    onError: (err: Error) => setNotice(`Import failed: ${err.message}`)
  });

  if (detail.isPending) return <Spinner />;
  if (detail.error) return <ErrorNote>{(detail.error as Error).message}</ErrorNote>;
  if (!detail.data) return null;

  const { subscription, downloads } = detail.data;
  const slots = [...(episodes.data?.episodes ?? []), ...(episodes.data?.extra ?? [])];
  const inLibrary = slots.filter((s) => s.status === 'imported').length;
  const airedCount = slots.filter((s) => s.aired).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold break-title">{subscription.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge>S{String(subscription.season).padStart(2, '0')}</Badge>
            {subscription.filter.fansubs?.map((fansub) => (
              <Badge key={fansub} tone="brand">
                {fansub}
              </Badge>
            ))}
            {subscription.filter.keywords?.map((keyword) => (
              <Badge key={keyword}>{keyword}</Badge>
            ))}
            {subscription.filter.exclude?.map((keyword) => (
              <Badge key={keyword} tone="danger">
                −{keyword}
              </Badge>
            ))}
            {!subscription.enabled && <Badge tone="warn">paused</Badge>}
            {!subscription.autoDownload && <Badge tone="warn">manual</Badge>}
          </div>
          <div className="mt-1.5 font-mono text-[11px] text-ink-500">
            {subscription.libraryFolder}/Season {String(subscription.season).padStart(2, '0')}/
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link to="/anime/$subjectId" params={{ subjectId: String(subscription.subjectId) }}>
            <Button size="sm">Browse releases</Button>
          </Link>
          <Button size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3" /> Edit
          </Button>
          <Button size="sm" onClick={() => scan.mutate(false)} disabled={scan.isPending}>
            <RefreshCw className={scan.isPending ? 'size-3 animate-spin' : 'size-3'} /> Check now
          </Button>
          <Button
            size="sm"
            onClick={() => scan.mutate(true)}
            disabled={scan.isPending}
            title="Ignore the cursor and re-scan the full history for missing episodes"
          >
            <History className="size-3" /> Backfill
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (
                confirm(
                  `Delete the subscription for “${subscription.title}”?\n\nFiles already in your Jellyfin library are kept.`
                )
              ) {
                remove.mutate();
              }
            }}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs break-title text-ink-300">
          {notice}
        </div>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Episodes</h2>
          <div className="text-[11px] text-ink-500">
            {inLibrary} of {airedCount} aired in library
          </div>
        </div>

        {episodes.isPending && <Spinner />}
        {slots.length > 0 ? (
          <Card>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5">
              {slots.map((slot) => (
                <EpisodeCell key={slot.ep} slot={slot} target={playTargets.get(slot.ep)} />
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-ink-500">
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded border border-brand-soft bg-brand/20" />
                in library — click to play
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded border border-eye/50 bg-eye/15" /> in progress
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded border border-ink-800 bg-ink-900" /> missing
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded border border-dashed border-ink-800" /> not yet aired
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2.5 rounded border border-red-800/60 bg-red-500/10" /> failed
              </span>
            </div>
          </Card>
        ) : (
          !episodes.isPending && (
            <Card>
              <div className="text-xs text-ink-500">
                Bangumi has no episode list for this show yet, so there is no grid to show. Downloads
                below still work.
              </div>
            </Card>
          )
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">
          Downloads <span className="text-ink-500">({downloads.length})</span>
        </h2>

        {downloads.length === 0 && (
          <Card>
            <div className="text-xs text-ink-500">
              Nothing grabbed yet. Use “Check now” to look for episodes published since the
              subscription was created, or “Backfill” to scan the full history.
            </div>
          </Card>
        )}

        <div className="space-y-1.5">
          {downloads.map((download) => (
            <Card key={download.id} className="py-2.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={download.status} />
                    {download.episode !== undefined && (
                      <Badge tone="brand">{formatEpisode(download.episode)}</Badge>
                    )}
                    {download.needsReview && (
                      <Badge tone="warn" title="Episode number came from the fallback parser">
                        check episode
                      </Badge>
                    )}
                    <span className="text-[11px] text-ink-500">
                      {formatSize(download.size)} · {formatRelative(download.addedAt)}
                    </span>
                  </div>
                  <div className="break-title text-[11px] leading-snug text-ink-300">
                    {download.title}
                  </div>
                  {download.error && <ErrorNote>{download.error}</ErrorNote>}
                  {download.status === 'downloading' && (
                    <div className="mt-1.5">
                      <Progress value={download.qbProgress} />
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 gap-1.5">
                  {download.status === 'failed' && (
                    <>
                      <Button size="sm" onClick={() => retry.mutate(download.id)}>
                        Retry
                      </Button>
                      <Button size="sm" onClick={() => reimport.mutate(download.id)}>
                        Re-import
                      </Button>
                    </>
                  )}
                  {download.status === 'imported' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => reimport.mutate(download.id)}
                      title="Rewrite the library files and NFOs for this download"
                    >
                      Re-import
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <SubscribeDialog
        open={editing}
        onClose={() => {
          setEditing(false);
          invalidate();
        }}
        subjectId={subscription.subjectId}
        suggested={{
          title: subscription.title,
          libraryFolder: subscription.libraryFolder,
          season: subscription.season
        }}
        existing={subscription}
      />
    </div>
  );
}
