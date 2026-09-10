import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import clsx from 'clsx';
import { useState } from 'react';
import { Download, Search as SearchIcon } from 'lucide-react';

import { api, formatSize, type Resource } from '../api';
import { useRelativeTime, useT } from '../i18n';
import { GrabDialog } from '../components/GrabDialog';
import { Badge, Button, Card, EmptyState, ErrorNote, Input, Spinner } from '../components/ui';

export function SearchPage() {
  const t = useT();
  const relative = useRelativeTime();
  const [grabbing, setGrabbing] = useState<Resource>();
  const [notice, setNotice] = useState<string>();
  const search = useSearch({ from: '/search' });
  const navigate = useNavigate();
  const [draft, setDraft] = useState(search.q ?? '');

  const query = search.q ?? '';
  const tab = search.tab;

  const submit = () =>
    navigate({ to: '/search', search: { q: draft.trim() || undefined, tab } });

  const setTab = (next: 'anime' | 'resources') =>
    navigate({ to: '/search', search: { q: query || undefined, tab: next } });

  const subjects = useQuery({
    queryKey: ['search-subjects', query],
    queryFn: () => api.searchSubjects(query),
    enabled: tab === 'anime' && query.length > 0
  });

  const resources = useQuery({
    queryKey: ['search-resources', query],
    queryFn: () => api.searchResources({ q: query }),
    enabled: tab === 'resources' && query.length > 0
  });

  return (
    <div className="space-y-5">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500" />
          <Input
            value={draft}
            onChange={setDraft}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
            placeholder={
              tab === 'anime'
                ? 'Search anime on Bangumi — 葬送的芙莉莲, Frieren…'
                : 'Search releases on AnimeGarden — 芙莉莲 1080p 简体…'
            }
            className="pl-9"
          />
        </div>
        <Button variant="primary" onClick={submit}>
          Search
        </Button>
      </div>

      <div className="flex gap-1 border-b border-ink-800">
        {(
          [
            ['anime', 'Anime (Bangumi)'],
            ['resources', 'Releases (AnimeGarden)']
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition',
              tab === key
                ? 'border-brand text-ink-100'
                : 'border-transparent text-ink-500 hover:text-ink-300'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!query && (
        <EmptyState
          title={t('search.emptyTitle')}
          description={t('search.emptyHint')}
        />
      )}

      {tab === 'anime' && query && (
        <>
          {subjects.isPending && <Spinner />}
          {subjects.error && <ErrorNote>{(subjects.error as Error).message}</ErrorNote>}
          {subjects.data?.subjects.length === 0 && (
            <EmptyState title={t('search.noAnime')} description={t('search.noAnimeHint', { query })} />
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subjects.data?.subjects.map((subject) => (
              <Link
                key={subject.id}
                to="/anime/$subjectId"
                params={{ subjectId: String(subject.id) }}
              >
                <Card className="flex h-full gap-3 transition hover:border-ink-500">
                  {subject.image ? (
                    <img
                      src={subject.image}
                      alt=""
                      className="h-28 w-20 shrink-0 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="h-28 w-20 shrink-0 rounded-lg bg-ink-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium break-title">{subject.title}</div>
                    {subject.name !== subject.title && (
                      <div className="mt-0.5 line-clamp-1 text-[11px] text-ink-500">
                        {subject.name}
                      </div>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {subject.year && <Badge>{subject.year}</Badge>}
                      {subject.score !== undefined && subject.score > 0 && (
                        <Badge tone="brand">★ {subject.score.toFixed(1)}</Badge>
                      )}
                      {subject.subscribed && <Badge tone="success">subscribed</Badge>}
                    </div>
                    {subject.summary && (
                      <p className="mt-1.5 line-clamp-3 text-[11px] leading-snug text-ink-500">
                        {subject.summary}
                      </p>
                    )}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </>
      )}

      {notice && (
        <div className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-xs break-title text-ink-300">
          {notice}
        </div>
      )}

      {tab === 'resources' && query && (
        <>
          {resources.isPending && <Spinner />}
          {resources.error && <ErrorNote>{(resources.error as Error).message}</ErrorNote>}
          {resources.data?.resources.length === 0 && (
            <EmptyState
              title={t('search.noReleasesTitle')}
              description={t('search.noReleasesHint', { query })}
            />
          )}

          <div className="space-y-1.5">
            {resources.data?.resources.map((resource) => (
              <Card key={resource.id} className="py-2.5">
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {resource.fansub && <Badge tone="brand">{resource.fansub}</Badge>}
                  {resource.parsed.episode !== undefined && (
                    <Badge>E{resource.parsed.episode}</Badge>
                  )}
                  {resource.parsed.resolution && <Badge>{resource.parsed.resolution}</Badge>}
                  <Badge>{resource.type}</Badge>
                  <span className="text-[11px] text-ink-500">
                    {formatSize(resource.size)} · {relative(resource.createdAt)}
                  </span>
                  {resource.subjectId && (
                    <Link
                      to="/anime/$subjectId"
                      params={{ subjectId: String(resource.subjectId) }}
                      className="text-[11px] text-brand hover:underline"
                    >
                      view anime →
                    </Link>
                  )}
                </div>
                <div className="flex items-start justify-between gap-3">
                  <div className="break-title text-xs leading-snug text-ink-300">
                    {resource.title}
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    className="shrink-0"
                    onClick={() => setGrabbing(resource)}
                  >
                    <Download className="size-3" /> {t('grab.download')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <GrabDialog
        open={grabbing !== undefined}
        resource={grabbing}
        onClose={() => setGrabbing(undefined)}
        onQueued={setNotice}
      />
    </div>
  );
}
