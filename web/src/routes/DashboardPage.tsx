import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

import { api, formatEpisode, formatRelative } from '../api';
import { ReadyToWatch } from '../components/ReadyToWatch';
import { Badge, Card, EmptyState, Progress, Spinner, StatusBadge } from '../components/ui';

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <Card>
      <div className="text-[11px] text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
    </Card>
  );
}

export function DashboardPage() {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions });
  const downloads = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.downloads(),
    refetchInterval: 15_000
  });

  const list = subs.data?.subscriptions ?? [];
  const rows = downloads.data?.downloads ?? [];
  const active = rows.filter((d) => ['queued', 'downloading', 'completed', 'importing'].includes(d.status));
  const failed = rows.filter((d) => d.status === 'failed');

  return (
    <div className="space-y-6">
      {health.data && health.data.status !== 'ok' && (
        <Card className="border-amber-900/60 bg-amber-950/20">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
            <AlertTriangle className="size-4" /> Some services need attention
          </div>
          <div className="space-y-1">
            {health.data.services
              .filter((s) => !s.ok)
              .map((s) => (
                <div key={s.name} className="flex gap-2 text-xs">
                  <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-400" />
                  <span className="text-ink-300">
                    <span className="font-medium">{s.name}:</span> {s.detail}
                  </span>
                </div>
              ))}
            {!health.data.paths.hardlink.ok && (
              <div className="flex gap-2 text-xs">
                <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-400" />
                <span className="text-ink-300">
                  <span className="font-medium">Filesystem:</span>{' '}
                  {health.data.paths.hardlink.detail}
                </span>
              </div>
            )}
          </div>
          <Link to="/settings" className="mt-2 inline-block text-xs text-brand hover:underline">
            Open settings →
          </Link>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Subscriptions" value={list.filter((s) => s.enabled).length} />
        <Stat label="Downloading" value={active.length} tone={active.length ? 'text-brand' : ''} />
        <Stat label="In library" value={rows.filter((d) => d.status === 'imported').length} />
        <Stat label="Failed" value={failed.length} tone={failed.length ? 'text-red-400' : ''} />
      </div>

      <ReadyToWatch limit={40} compact />

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Active downloads</h2>
            <Link to="/downloads" className="text-xs text-brand hover:underline">
              All downloads →
            </Link>
          </div>

          {downloads.isPending && <Spinner />}
          {!downloads.isPending && active.length === 0 && (
            <EmptyState title="Nothing downloading" description="New episodes appear here as they are picked up." />
          )}

          <div className="space-y-2">
            {active.slice(0, 8).map((download) => (
              <Card key={download.id} className="py-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={download.status} />
                    {download.episode !== undefined && (
                      <Badge tone="brand">{formatEpisode(download.episode)}</Badge>
                    )}
                  </div>
                  <span className="text-[11px] text-ink-500">
                    {Math.round(download.qbProgress * 100)}%
                  </span>
                </div>
                <div className="mb-1.5 line-clamp-1 text-[11px] text-ink-300">{download.title}</div>
                <Progress value={download.qbProgress} />
              </Card>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Subscriptions</h2>
            <Link to="/subscriptions" className="text-xs text-brand hover:underline">
              Manage →
            </Link>
          </div>

          {subs.isPending && <Spinner />}
          {!subs.isPending && list.length === 0 && (
            <EmptyState
              title="No subscriptions yet"
              description="Find a show under Search or Airing, then subscribe to have new episodes downloaded and filed into Jellyfin automatically."
            />
          )}

          <div className="space-y-2">
            {list.slice(0, 8).map((subscription) => (
              <Link
                key={subscription.id}
                to="/subscriptions/$id"
                params={{ id: String(subscription.id) }}
              >
                <Card className="transition hover:border-ink-500">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{subscription.title}</div>
                      <div className="mt-0.5 text-[11px] text-ink-500">
                        {subscription.lastCheckedAt
                          ? `checked ${formatRelative(subscription.lastCheckedAt)}`
                          : 'not checked yet'}
                        {subscription.filter.fansubs?.length
                          ? ` · ${subscription.filter.fansubs.join(', ')}`
                          : ''}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {subscription.stats?.latestEpisode !== undefined && (
                        <Badge tone="success">
                          <CheckCircle2 className="mr-1 size-3" />
                          {formatEpisode(subscription.stats.latestEpisode)}
                        </Badge>
                      )}
                      {!subscription.enabled && <Badge tone="warn">paused</Badge>}
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
