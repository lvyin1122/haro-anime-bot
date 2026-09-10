import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { useMemo } from 'react';

import { api, formatEpisode, type Download, type Subscription } from '../api';
import { useRelativeTime, useT } from '../i18n';
import { ReadyToWatch } from '../components/ReadyToWatch';
import { Badge, Card, EmptyState, Poster, Progress, Spinner, StatusBadge } from '../components/ui';

const ACTIVE_STATUSES = ['queued', 'downloading', 'completed', 'importing'];

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <Card>
      <div className="text-[11px] text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? ''}`}>{value}</div>
    </Card>
  );
}

export function DashboardPage() {
  const t = useT();
  const relative = useRelativeTime();

  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions });
  const downloads = useQuery({
    queryKey: ['downloads'],
    queryFn: () => api.downloads(),
    refetchInterval: 15_000
  });
  const calendar = useQuery({
    queryKey: ['calendar'],
    queryFn: api.calendar,
    staleTime: 30 * 60_000
  });

  const list = subs.data?.subscriptions ?? [];
  const rows = downloads.data?.downloads ?? [];
  const active = rows.filter((d) => ACTIVE_STATUSES.includes(d.status));
  const failed = rows.filter((d) => d.status === 'failed');

  // A download knows its subscription, and the subscription carries the cover
  // art — so the two lists together give every row a poster with no extra
  // request.
  const postersBySubscription = useMemo(() => {
    const map = new Map<number, string>();
    for (const subscription of list) {
      if (subscription.poster) map.set(subscription.id, subscription.poster);
    }
    return map;
  }, [list]);

  // Bangumi numbers weekdays 1-7 from Monday; getDay() numbers them 0-6 from
  // Sunday, so Sunday is 7 rather than 0.
  const todayId = new Date().getDay() === 0 ? 7 : new Date().getDay();
  const airingToday = calendar.data?.days.find((day) => day.weekday.id === todayId);

  return (
    <div className="space-y-6">
      {health.data && health.data.status !== 'ok' && (
        <Card className="border-amber-900/60 bg-amber-950/20">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-400">
            <AlertTriangle className="size-4" /> {t('dashboard.servicesTitle')}
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
                  <span className="font-medium">{t('dashboard.filesystem')}:</span>{' '}
                  {health.data.paths.hardlink.detail}
                </span>
              </div>
            )}
          </div>
          <Link to="/settings" className="mt-2 inline-block text-xs text-brand hover:underline">
            {t('dashboard.openSettings')}
          </Link>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={t('dashboard.stat.subscriptions')}
          value={list.filter((s) => s.enabled).length}
        />
        <Stat
          label={t('dashboard.stat.downloading')}
          value={active.length}
          tone={active.length ? 'text-brand' : ''}
        />
        <Stat
          label={t('dashboard.stat.inLibrary')}
          value={rows.filter((d) => d.status === 'imported').length}
        />
        <Stat
          label={t('dashboard.stat.failed')}
          value={failed.length}
          tone={failed.length ? 'text-red-400' : ''}
        />
      </div>

      <ReadyToWatch limit={40} compact />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('dashboard.airingToday')}</h2>
          <Link to="/calendar" className="text-xs text-brand hover:underline">
            {t('dashboard.fullCalendar')}
          </Link>
        </div>

        {calendar.isPending && <Spinner label={t('common.loading')} />}

        {!calendar.isPending && !airingToday?.items.length && (
          <EmptyState
            title={t('dashboard.airingTodayEmpty')}
            description={t('dashboard.airingTodayEmptyHint')}
          />
        )}

        {!!airingToday?.items.length && (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {airingToday.items.map((item) => (
              <Link
                key={item.id}
                to="/anime/$subjectId"
                params={{ subjectId: String(item.id) }}
                className="group/card"
                title={item.title}
              >
                <Poster
                  src={item.image}
                  alt={item.title}
                  className="aspect-[2/3] w-full transition group-hover/card:brightness-110"
                />
                <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-300 break-title">
                  {item.title}
                </div>
                <div className="mt-0.5 flex items-center gap-1">
                  {item.score !== undefined && item.score > 0 && (
                    <span className="text-[10px] text-ink-500">★ {item.score.toFixed(1)}</span>
                  )}
                  {item.subscribed && <Badge tone="success">{t('dashboard.subscribed')}</Badge>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('dashboard.activeDownloads')}</h2>
            <Link to="/downloads" className="text-xs text-brand hover:underline">
              {t('dashboard.allDownloads')}
            </Link>
          </div>

          {downloads.isPending && <Spinner label={t('common.loading')} />}
          {!downloads.isPending && active.length === 0 && (
            <EmptyState
              title={t('dashboard.nothingDownloading')}
              description={t('dashboard.nothingDownloadingHint')}
            />
          )}

          <div className="space-y-2.5">
            {active.slice(0, 8).map((download) => (
              <DownloadRow
                key={download.id}
                download={download}
                poster={
                  download.subscriptionId === undefined
                    ? undefined
                    : postersBySubscription.get(download.subscriptionId)
                }
              />
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('dashboard.subscriptions')}</h2>
            <Link to="/subscriptions" className="text-xs text-brand hover:underline">
              {t('dashboard.manage')}
            </Link>
          </div>

          {subs.isPending && <Spinner label={t('common.loading')} />}
          {!subs.isPending && list.length === 0 && (
            <EmptyState
              title={t('dashboard.noSubscriptions')}
              description={t('dashboard.noSubscriptionsHint')}
            />
          )}

          <div className="space-y-2.5">
            {list.slice(0, 8).map((subscription) => (
              <SubscriptionRow
                key={subscription.id}
                subscription={subscription}
                checked={
                  subscription.lastCheckedAt
                    ? t('dashboard.checkedAt', { when: relative(subscription.lastCheckedAt) })
                    : t('dashboard.notChecked')
                }
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function DownloadRow({ download, poster }: { download: Download; poster?: string }) {
  return (
    <Card className="py-3">
      <div className="flex gap-3">
        <Poster src={poster} alt="" className="h-16 w-11 shrink-0" />
        <div className="min-w-0 flex-1">
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
          <div className="mb-1.5 line-clamp-2 text-[11px] leading-snug text-ink-300 break-title">
            {download.title}
          </div>
          <Progress value={download.qbProgress} />
        </div>
      </div>
    </Card>
  );
}

function SubscriptionRow({
  subscription,
  checked
}: {
  subscription: Subscription;
  checked: string;
}) {
  const t = useT();
  return (
    <Link to="/subscriptions/$id" params={{ id: String(subscription.id) }}>
      <Card className="py-3 transition hover:border-ink-500">
        <div className="flex gap-3">
          <Poster src={subscription.poster} alt="" className="h-16 w-11 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{subscription.title}</div>
              <div className="mt-1 text-[11px] leading-relaxed text-ink-500">
                {checked}
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
              {!subscription.enabled && <Badge tone="warn">{t('common.paused')}</Badge>}
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
