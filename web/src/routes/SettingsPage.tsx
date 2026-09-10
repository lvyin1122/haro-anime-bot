import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';

import { api, formatRelative } from '../api';
import { LOCALES, useI18n, useT } from '../i18n';
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
  const t = useT();
  const { locale, setLocale } = useI18n();
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
  const playerMode = health.data?.playerMode ?? 'builtin';

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">{t('settings.title')}</h1>

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

      <Card>
        <h2 className="mb-1 text-sm font-semibold">{t('settings.language')}</h2>
        <p className="mb-3 text-[11px] leading-relaxed text-ink-500">{t('settings.languageHint')}</p>
        <div className="flex flex-wrap gap-1.5">
          {LOCALES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setLocale(option.id)}
              className={clsx(
                'rounded-lg border px-3 py-1.5 text-xs font-medium transition',
                option.id === locale
                  ? 'border-brand bg-brand/15 text-brand'
                  : 'border-ink-700 bg-ink-800 text-ink-300 hover:border-ink-500 hover:text-ink-100'
              )}
            >
              {option.label}
              {/* The endonym alone is unreadable in a language you cannot read,
                  which is exactly the situation someone changing this is in. */}
              {option.id !== 'en' && <span className="ml-1.5 text-ink-500">{option.english}</span>}
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t('settings.serviceStatus')}</h2>
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
              {t('settings.testQbittorrent')}
            </Button>
            {/* Nothing to test or rescan when Jellyfin is not the player. */}
            {playerMode === 'jellyfin' && (
              <>
                <Button size="sm" onClick={() => testJf.mutate()} disabled={testJf.isPending}>
                  {t('settings.testJellyfin')}
                </Button>
                <Button size="sm" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
                  {t('settings.rescanJellyfin')}
                </Button>
              </>
            )}
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
          <h2 className="mb-2 text-sm font-semibold">{t('settings.filesystem')}</h2>

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

          <Row label={t('settings.row.downloadsHere')} value={String(config.downloadRoot ?? '—')} />
          <Row label={t('settings.row.downloadsQb')} value={String(config.qbDownloadRoot ?? '—')} />
          <Row label={t('settings.row.library')} value={String(config.libraryRoot ?? '—')} />
          <Row label={t('settings.row.dataDir')} value={String(config.dataDir ?? '—')} />

          {hardlink && !hardlink.sameDevice && (
            <div className="mt-3">
              <ErrorNote>
                {t('settings.crossDevice')}
              </ErrorNote>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold">{t('settings.configuration')}</h2>
          <Row label="qBittorrent" value={String(config.qbittorrentUrl ?? '—')} />
          <Row label={t('settings.row.username')} value={String(config.qbittorrentUsername ?? '—')} />
          <Row label={t('settings.row.password')}
            value={config.qbittorrentPasswordSet ? t('common.set') : t('common.notSet')} />
          <Row label={t('settings.row.category')} value={String(config.qbittorrentCategory ?? '—')} />
          <Row
            label={t('settings.player')}
            value={
              playerMode === 'builtin'
                ? t('settings.playerBuiltin')
                : config.playerMode === 'auto'
                  ? t('settings.playerJellyfinAuto')
                  : t('settings.playerJellyfin')
            }
          />
          {playerMode === 'jellyfin' && (
            <>
              <Row label={t('settings.row.jellyfinServer')} value={String(config.jellyfinUrl ?? '—')} />
              <Row
                label={t('settings.row.jellyfinLinks')}
                value={
                  config.jellyfinPublicUrl
                    ? String(config.jellyfinPublicUrl)
                    : t('settings.row.assumed', {
                        url: `${window.location.protocol}//${window.location.hostname}:8096`
                      })
                }
              />
              <Row label={t('settings.row.apiKey')}
                value={config.jellyfinApiKeySet ? t('common.set') : t('common.notSet')} />
            </>
          )}
          <Row label="AnimeGarden" value={String(config.animegardenApi ?? '—')} />
          <Row label="Bangumi" value={String(config.bangumiApi ?? '—')} />
          <Row label={t('settings.row.pollInterval')}
            value={t('settings.minutes', { count: String(config.pollIntervalMinutes ?? '—') })} />
          <Row label={t('settings.row.monitorInterval')}
            value={t('settings.seconds', { count: String(config.monitorIntervalSeconds ?? '—') })} />
          <Row label={t('settings.row.timezone')} value={String(config.timezone ?? '—')} />
          <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
            These come from environment variables. Edit <code className="text-ink-300">.env</code> on
            the Pi and run <code className="text-ink-300">docker compose up -d</code> to apply.
          </p>
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-semibold">{t('settings.activity')}</h2>
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
