import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';

import { api, formatRelative } from '../api';
import { Button, Card, ErrorNote, Spinner } from '../components/ui';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-800/60 py-1.5 last:border-0">
      <span className="shrink-0 text-[11px] text-ink-500">{label}</span>
      <span className="text-right font-mono text-[11px] break-all text-ink-300">{value}</span>
    </div>
  );
}

function ServiceLine({ ok, name, detail }: { ok: boolean; name: string; detail: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {ok ? (
        <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
      ) : (
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-red-400" />
      )}
      <div className="min-w-0">
        <div className="text-xs font-medium">{name}</div>
        <div className="text-[11px] break-title text-ink-500">{detail}</div>
      </div>
    </div>
  );
}

export function SettingsPage() {
  const [results, setResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const events = useQuery({ queryKey: ['events'], queryFn: api.events, refetchInterval: 20_000 });

  const record = (key: string) => ({
    onSuccess: (result: { ok: boolean; detail: string }) =>
      setResults((previous) => ({ ...previous, [key]: result })),
    onError: (error: Error) =>
      setResults((previous) => ({ ...previous, [key]: { ok: false, detail: error.message } }))
  });

  const testQb = useMutation({ mutationFn: api.testQbittorrent, ...record('qbittorrent') });
  const testJf = useMutation({ mutationFn: api.testJellyfin, ...record('jellyfin') });
  const rescan = useMutation({ mutationFn: api.refreshJellyfin, ...record('refresh') });

  const config = settings.data?.config ?? {};
  const hardlink = health.data?.paths.hardlink;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Settings</h1>

      {settings.data && settings.data.warnings.length > 0 && (
        <Card className="border-amber-900/60 bg-amber-950/20">
          <div className="mb-1.5 text-xs font-medium text-amber-400">Configuration warnings</div>
          <ul className="space-y-1">
            {settings.data.warnings.map((warning) => (
              <li key={warning} className="text-[11px] text-ink-300">
                • {warning}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Service status</h2>
            <Button size="sm" onClick={() => void health.refetch()} disabled={health.isFetching}>
              <RefreshCw className={health.isFetching ? 'size-3 animate-spin' : 'size-3'} />
            </Button>
          </div>

          {health.isPending && <Spinner />}
          {health.data?.services.map((service) => (
            <ServiceLine key={service.name} {...service} />
          ))}

          <div className="mt-3 flex flex-wrap gap-2 border-t border-ink-800 pt-3">
            <Button size="sm" onClick={() => testQb.mutate()} disabled={testQb.isPending}>
              Test qBittorrent
            </Button>
            <Button size="sm" onClick={() => testJf.mutate()} disabled={testJf.isPending}>
              Test Jellyfin
            </Button>
            <Button size="sm" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
              Rescan Jellyfin library
            </Button>
          </div>

          {Object.entries(results).map(([key, result]) => (
            <div
              key={key}
              className={clsx(
                'mt-2 rounded-lg border px-3 py-2 text-[11px] break-title',
                result.ok
                  ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
                  : 'border-red-900/60 bg-red-950/30 text-red-300'
              )}
            >
              {result.detail}
            </div>
          ))}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold">Filesystem</h2>

          {hardlink && (
            <div
              className={clsx(
                'mb-3 rounded-lg border px-3 py-2 text-[11px] break-title',
                hardlink.ok
                  ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
                  : 'border-red-900/60 bg-red-950/30 text-red-300'
              )}
            >
              {hardlink.detail}
            </div>
          )}

          <Row label="Downloads (this container)" value={String(config.downloadRoot ?? '—')} />
          <Row label="Downloads (qBittorrent)" value={String(config.qbDownloadRoot ?? '—')} />
          <Row label="Jellyfin library" value={String(config.libraryRoot ?? '—')} />
          <Row label="Data directory" value={String(config.dataDir ?? '—')} />

          {hardlink && !hardlink.sameDevice && (
            <div className="mt-3">
              <ErrorNote>
                Downloads and library are on different filesystems. Hardlinks cannot cross devices —
                mount both from one host filesystem in docker-compose.yml.
              </ErrorNote>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold">Configuration</h2>
          <Row label="qBittorrent" value={String(config.qbittorrentUrl ?? '—')} />
          <Row label="Username" value={String(config.qbittorrentUsername ?? '—')} />
          <Row label="Password" value={config.qbittorrentPasswordSet ? 'set' : 'not set'} />
          <Row label="Category" value={String(config.qbittorrentCategory ?? '—')} />
          <Row label="Jellyfin (server-side)" value={String(config.jellyfinUrl ?? '—')} />
          <Row
            label="Jellyfin (play links)"
            value={
              config.jellyfinPublicUrl
                ? String(config.jellyfinPublicUrl)
                : `${window.location.protocol}//${window.location.hostname}:8096 (assumed)`
            }
          />
          <Row label="API key" value={config.jellyfinApiKeySet ? 'set' : 'not set'} />
          <Row label="AnimeGarden" value={String(config.animegardenApi ?? '—')} />
          <Row label="Bangumi" value={String(config.bangumiApi ?? '—')} />
          <Row label="Poll interval" value={`${config.pollIntervalMinutes ?? '—'} min`} />
          <Row label="Monitor interval" value={`${config.monitorIntervalSeconds ?? '—'} s`} />
          <Row label="Timezone" value={String(config.timezone ?? '—')} />
          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
            These come from environment variables. Edit <code className="text-ink-300">.env</code> on
            the Pi and run <code className="text-ink-300">docker compose up -d</code> to apply.
          </p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold">Activity</h2>
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {events.data?.events.map((event) => (
              <div key={event.id} className="flex gap-2 border-b border-ink-800/50 py-1 last:border-0">
                <span
                  className={clsx(
                    'mt-1 size-1.5 shrink-0 rounded-full',
                    event.level === 'error'
                      ? 'bg-red-400'
                      : event.level === 'warn'
                        ? 'bg-amber-400'
                        : 'bg-ink-600'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] break-title text-ink-300">{event.message}</div>
                  <div className="text-[10px] text-ink-500">
                    {event.scope} · {formatRelative(event.createdAt)}
                  </div>
                </div>
              </div>
            ))}
            {events.data?.events.length === 0 && (
              <div className="py-6 text-center text-xs text-ink-500">No activity yet.</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
