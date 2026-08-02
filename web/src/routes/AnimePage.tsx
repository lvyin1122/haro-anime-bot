import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { Download, ExternalLink, Rss } from 'lucide-react';

import { api, formatRelative, formatSize, type Resource } from '../api';
import { SubscribeDialog } from '../components/SubscribeDialog';
import { Badge, Button, Card, ErrorNote, Spinner } from '../components/ui';

export function AnimePage() {
  const { subjectId } = useParams({ from: '/anime/$subjectId' });
  const id = Number(subjectId);
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const { data, isPending, error } = useQuery({
    queryKey: ['anime', id],
    queryFn: () => api.anime(id)
  });

  const grab = useMutation({
    mutationFn: (resource: Resource) =>
      api.addDownload({
        magnet: resource.magnet,
        tracker: resource.tracker,
        title: resource.title,
        subscriptionId: data?.subscription?.id,
        resourceId: resource.id,
        provider: resource.provider,
        providerId: resource.providerId,
        size: resource.size,
        fansub: resource.fansub
      }),
    onSuccess: (result) => {
      setNotice(
        result.alreadyQueued
          ? 'That release is already in the download list.'
          : `Sent to qBittorrent: ${result.download.title.slice(0, 60)}…`
      );
      void queryClient.invalidateQueries({ queryKey: ['downloads'] });
    },
    onError: (err: Error) => setNotice(`Failed: ${err.message}`)
  });

  if (isPending) return <Spinner label="Loading anime…" />;
  if (error) return <ErrorNote>{(error as Error).message}</ErrorNote>;
  if (!data) return null;

  const { subject, episodes, fansubs, subscription, suggested } = data;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-5 sm:flex-row">
        {subject.image && (
          <img
            src={subject.image}
            alt=""
            className="h-64 w-44 shrink-0 self-start rounded-xl object-cover shadow-lg"
          />
        )}

        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <h1 className="text-xl font-semibold break-title">{subject.title}</h1>
            {subject.name !== subject.title && (
              <div className="mt-0.5 text-sm break-title text-ink-500">{subject.name}</div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {subject.score !== undefined && <Badge tone="brand">★ {subject.score.toFixed(1)}</Badge>}
            {subject.rank !== undefined && <Badge>#{subject.rank}</Badge>}
            {subject.date && <Badge>{subject.date}</Badge>}
            {subject.platform && <Badge>{subject.platform}</Badge>}
            <Badge>{subject.eps} eps</Badge>
            <a
              href={`https://bgm.tv/subject/${subject.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-ink-800 px-1.5 py-0.5 text-[11px] text-ink-300 hover:text-ink-100"
            >
              Bangumi <ExternalLink className="size-3" />
            </a>
          </div>

          {subject.summary && (
            <p className="max-h-40 overflow-y-auto text-xs leading-relaxed whitespace-pre-line text-ink-300">
              {subject.summary}
            </p>
          )}

          <div className="flex flex-wrap gap-1">
            {subject.tags.map((tag) => (
              <span key={tag} className="rounded bg-ink-800/70 px-1.5 py-0.5 text-[10px] text-ink-500">
                {tag}
              </span>
            ))}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {subscription ? (
              <>
                <Link to="/subscriptions/$id" params={{ id: String(subscription.id) }}>
                  <Button variant="primary">
                    <Rss className="size-3.5" /> Manage subscription
                  </Button>
                </Link>
                <Button onClick={() => setDialogOpen(true)}>Edit filter</Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => setDialogOpen(true)}>
                <Rss className="size-3.5" /> Subscribe
              </Button>
            )}
          </div>
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-ink-300">
          {notice}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">
            Releases <span className="text-ink-500">({fansubs.length} groups)</span>
          </h2>

          {fansubs.length === 0 && (
            <Card>
              <div className="text-xs text-ink-500">
                AnimeGarden has no resources indexed for this subject yet.
              </div>
            </Card>
          )}

          {fansubs.map((group) => {
            const open = expanded === group.name;
            return (
              <Card key={group.name} className="p-0">
                <button
                  onClick={() => setExpanded(open ? undefined : group.name)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-ink-800/40"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{group.name}</span>
                    <Badge>{group.count}</Badge>
                    {group.latestEpisode !== undefined && (
                      <Badge tone="success">latest E{group.latestEpisode}</Badge>
                    )}
                  </div>
                  <span className="text-xs text-ink-500">{open ? 'Hide' : 'Show'}</span>
                </button>

                {open && (
                  <div className="max-h-96 overflow-y-auto border-t border-ink-800">
                    {group.resources.map((resource) => (
                      <div
                        key={resource.id}
                        className="flex items-start gap-3 border-b border-ink-800/60 px-4 py-2.5 last:border-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-1.5">
                            {resource.parsed.episode !== undefined && (
                              <Badge tone="brand">
                                E{resource.parsed.episode}
                                {resource.parsed.episodeTo
                                  ? `–${resource.parsed.episodeTo}`
                                  : ''}
                              </Badge>
                            )}
                            {resource.parsed.lowConfidence && <Badge tone="warn">guessed</Badge>}
                            {resource.parsed.resolution && (
                              <Badge>{resource.parsed.resolution}</Badge>
                            )}
                            {resource.parsed.subtitleLanguages?.map((lang) => (
                              <Badge key={lang}>{lang}</Badge>
                            ))}
                            <span className="text-[11px] text-ink-500">
                              {formatSize(resource.size)} · {formatRelative(resource.createdAt)}
                            </span>
                          </div>
                          <div className="break-title text-[11px] leading-snug text-ink-300">
                            {resource.title}
                          </div>
                        </div>

                        <Button
                          size="sm"
                          onClick={() => grab.mutate(resource)}
                          disabled={grab.isPending}
                          title="Send this magnet to qBittorrent"
                        >
                          <Download className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">
            Episodes <span className="text-ink-500">({episodes.length})</span>
          </h2>
          <Card className="max-h-[32rem] overflow-y-auto p-0">
            {episodes.map((episode) => {
              const aired = Boolean(episode.airdate) && episode.airdate <= today;
              return (
                <div
                  key={episode.ep}
                  className="flex items-start gap-2 border-b border-ink-800/60 px-3 py-2 last:border-0"
                >
                  <span className="mt-0.5 w-8 shrink-0 text-[11px] font-medium text-ink-500">
                    {episode.ep}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-ink-300" title={episode.title}>
                      {episode.title}
                    </div>
                    <div className="text-[10px] text-ink-500">
                      {episode.airdate || 'TBA'}
                      {!aired && episode.airdate ? ' · upcoming' : ''}
                    </div>
                  </div>
                </div>
              );
            })}
            {episodes.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-ink-500">
                Bangumi has no episode list for this subject.
              </div>
            )}
          </Card>
        </section>
      </div>

      <SubscribeDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        subjectId={id}
        suggested={suggested}
        existing={subscription}
        fansubOptions={fansubs.map((f) => ({
          name: f.name,
          count: f.count,
          latestEpisode: f.latestEpisode
        }))}
      />
    </div>
  );
}
