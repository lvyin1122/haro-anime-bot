import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { api, formatEpisode, formatRelative } from '../api';
import { Badge, Button, Card, EmptyState, ErrorNote, Spinner } from '../components/ui';

export function SubscriptionsPage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>();

  const { data, isPending, error } = useQuery({
    queryKey: ['subscriptions'],
    queryFn: api.subscriptions
  });

  const scanAll = useMutation({
    mutationFn: api.scanAll,
    onSuccess: () => {
      setNotice('Checked every subscription for new episodes.');
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (err: Error) => setNotice(`Scan failed: ${err.message}`)
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      api.updateSubscription(id, { enabled }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['subscriptions'] })
  });

  const list = data?.subscriptions ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Subscriptions</h1>
          <p className="mt-0.5 text-xs text-ink-500">
            Each subscription watches AnimeGarden for new episodes of one show and files them into
            Jellyfin.
          </p>
        </div>
        <Button onClick={() => scanAll.mutate()} disabled={scanAll.isPending}>
          <RefreshCw className={scanAll.isPending ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Check now
        </Button>
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-ink-300">
          {notice}
        </div>
      )}

      {isPending && <Spinner />}
      {error && <ErrorNote>{(error as Error).message}</ErrorNote>}

      {!isPending && list.length === 0 && (
        <EmptyState
          title="No subscriptions yet"
          description="Search for an anime or browse the airing calendar, open it, and choose Subscribe."
          action={
            <Link to="/search" search={{ q: undefined, tab: 'anime' as const }}>
              <Button variant="primary">Find an anime</Button>
            </Link>
          }
        />
      )}

      <div className="space-y-2">
        {list.map((subscription) => (
          <Card key={subscription.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Link
                  to="/subscriptions/$id"
                  params={{ id: String(subscription.id) }}
                  className="text-sm font-medium hover:text-brand"
                >
                  {subscription.title}
                </Link>

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
                  {subscription.episodeOffset !== 0 && (
                    <Badge tone="warn">offset {subscription.episodeOffset}</Badge>
                  )}
                  {!subscription.enabled && <Badge tone="warn">paused</Badge>}
                  {!subscription.autoDownload && <Badge tone="warn">manual</Badge>}
                </div>

                <div className="mt-1.5 text-[11px] text-ink-500">
                  <span className="font-mono">{subscription.libraryFolder}</span>
                  {' · '}
                  {subscription.lastCheckedAt
                    ? `checked ${formatRelative(subscription.lastCheckedAt)}`
                    : 'never checked'}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                {subscription.stats && (
                  <div className="text-right text-[11px] text-ink-500">
                    <div>
                      <span className="text-brand">{subscription.stats.imported}</span> in
                      library
                    </div>
                    {subscription.stats.active > 0 && (
                      <div className="text-brand">{subscription.stats.active} downloading</div>
                    )}
                    {subscription.stats.failed > 0 && (
                      <div className="text-red-400">{subscription.stats.failed} failed</div>
                    )}
                    {subscription.stats.latestEpisode !== undefined && (
                      <div>latest {formatEpisode(subscription.stats.latestEpisode)}</div>
                    )}
                  </div>
                )}

                <Button
                  size="sm"
                  onClick={() =>
                    toggle.mutate({ id: subscription.id, enabled: !subscription.enabled })
                  }
                >
                  {subscription.enabled ? 'Pause' : 'Resume'}
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
