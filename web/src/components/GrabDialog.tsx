import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api, formatSize, type Resource } from '../api';
import { useT } from '../i18n';
import { Badge, Button, ErrorNote, Input, Label, Modal } from './ui';

/**
 * Queue one release by hand, with a chance to fix what the parser got wrong.
 *
 * The important field is the subscription: without one the file lands in the
 * download category's root and is never filed, because there is no library
 * folder, season or episode offset to file it with. Everything else is
 * pre-filled from the release title and only needs touching when the parse
 * looks wrong — which the dialog shows you before you commit.
 */
export function GrabDialog({
  open,
  onClose,
  resource,
  onQueued
}: {
  open: boolean;
  onClose: () => void;
  resource?: Resource;
  onQueued?: (message: string) => void;
}) {
  const t = useT();
  const subs = useQuery({ queryKey: ['subscriptions'], queryFn: api.subscriptions, enabled: open });

  const [subscriptionId, setSubscriptionId] = useState<string>('');
  const [episode, setEpisode] = useState<string>('');
  const [fansub, setFansub] = useState<string>('');
  const [error, setError] = useState<string>();

  // Re-seed every time the dialog opens on a different release.
  useEffect(() => {
    if (!open || !resource) return;
    setError(undefined);
    setEpisode(resource.parsed.episode === undefined ? '' : String(resource.parsed.episode));
    setFansub(resource.fansub ?? '');

    // A release that names its subject can usually pick its own subscription.
    const match = subs.data?.subscriptions.find((s) => s.subjectId === resource.subjectId);
    setSubscriptionId(match ? String(match.id) : '');
  }, [open, resource, subs.data]);

  const grab = useMutation({
    mutationFn: () => {
      if (!resource) throw new Error('No release selected');
      const episodeNumber = episode.trim() === '' ? undefined : Number(episode);
      return api.addDownload({
        magnet: resource.magnet,
        tracker: resource.tracker,
        title: resource.title,
        resourceId: resource.id,
        provider: resource.provider,
        providerId: resource.providerId,
        size: resource.size,
        ...(fansub.trim() ? { fansub: fansub.trim() } : {}),
        ...(subscriptionId ? { subscriptionId: Number(subscriptionId) } : {}),
        ...(episodeNumber !== undefined && Number.isFinite(episodeNumber)
          ? { episode: episodeNumber }
          : {})
      });
    },
    onSuccess: (result) => {
      onQueued?.(
        result.alreadyQueued
          ? t('grab.alreadyQueued')
          : t('grab.queued', { title: result.download.title })
      );
      onClose();
    },
    onError: (err: Error) => setError(err.message)
  });

  if (!resource) return null;

  return (
    <Modal open={open} onClose={onClose} title={t('grab.title')}>
      <div className="space-y-4">
        <div>
          <Label>{t('grab.release')}</Label>
          <div className="rounded-lg border border-ink-800 bg-ink-950/50 px-3 py-2">
            <div className="break-title text-[11px] leading-snug text-ink-300">
              {resource.title}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {resource.fansub && <Badge tone="brand">{resource.fansub}</Badge>}
              {resource.parsed.resolution && <Badge>{resource.parsed.resolution}</Badge>}
              <span className="text-[10px] text-ink-500">{formatSize(resource.size)}</span>
            </div>
          </div>
        </div>

        <div>
          <Label hint={t('grab.fileIntoHint')}>{t('grab.fileInto')}</Label>
          <select
            value={subscriptionId}
            onChange={(event) => setSubscriptionId(event.target.value)}
            className="w-full rounded-lg border border-ink-700 bg-ink-950/70 px-3 py-2 text-sm
                       focus:border-brand focus:ring-1 focus:ring-brand focus:outline-none"
          >
            <option value="">{t('grab.noSubscription')}</option>
            {subs.data?.subscriptions.map((subscription) => (
              <option key={subscription.id} value={subscription.id}>
                {subscription.title}
              </option>
            ))}
          </select>
          {!subscriptionId && (
            <p className="mt-1.5 text-[11px] leading-snug text-amber-400">
              {t('grab.noSubscriptionWarning')}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label hint={t('grab.episodeHint')}>{t('grab.episode')}</Label>
            <Input type="number" value={episode} onChange={setEpisode} />
            {resource.parsed.episode === undefined && (
              <p className="mt-1.5 text-[11px] leading-snug text-amber-400">
                {t('grab.episodeUnknown')}
              </p>
            )}
          </div>
          <div>
            <Label>{t('grab.fansub')}</Label>
            <Input value={fansub} onChange={setFansub} />
          </div>
        </div>

        {error && <ErrorNote>{error}</ErrorNote>}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => grab.mutate()} disabled={grab.isPending}>
            {grab.isPending ? t('grab.queuing') : t('grab.download')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
