import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { api, formatSize, type Subscription, type SubscriptionFilter } from '../api';
import {
  Badge,
  Button,
  ErrorNote,
  Input,
  Label,
  Modal,
  Spinner,
  TagInput
} from './ui';

interface Props {
  open: boolean;
  onClose: () => void;
  subjectId: number;
  /** Prefill for a new subscription. */
  suggested: { title: string; libraryFolder: string; season: number };
  /** When present the dialog edits instead of creating. */
  existing?: Subscription | null;
  fansubOptions?: Array<{ name: string; count: number; latestEpisode?: number }>;
}

const EMPTY: SubscriptionFilter = { fansubs: [], keywords: [], exclude: [], include: [] };

export function SubscribeDialog({
  open,
  onClose,
  subjectId,
  suggested,
  existing,
  fansubOptions = []
}: Props) {
  const queryClient = useQueryClient();

  const [title, setTitle] = useState(suggested.title);
  const [libraryFolder, setLibraryFolder] = useState(suggested.libraryFolder);
  const [season, setSeason] = useState(String(suggested.season));
  const [episodeOffset, setEpisodeOffset] = useState('0');
  const [filter, setFilter] = useState<SubscriptionFilter>(EMPTY);
  const [autoDownload, setAutoDownload] = useState(true);
  const [backfillDays, setBackfillDays] = useState('0');
  const [error, setError] = useState<string>();

  // Reset whenever the dialog opens so a previous edit never leaks across.
  useEffect(() => {
    if (!open) return;
    setError(undefined);
    if (existing) {
      setTitle(existing.title);
      setLibraryFolder(existing.libraryFolder);
      setSeason(String(existing.season));
      setEpisodeOffset(String(existing.episodeOffset));
      setFilter({ ...EMPTY, ...existing.filter });
      setAutoDownload(existing.autoDownload);
    } else {
      setTitle(suggested.title);
      setLibraryFolder(suggested.libraryFolder);
      setSeason(String(suggested.season));
      setEpisodeOffset('0');
      setFilter(EMPTY);
      setAutoDownload(true);
      setBackfillDays('0');
    }
  }, [open, existing, suggested.title, suggested.libraryFolder, suggested.season]);

  const offsetNumber = Number(episodeOffset) || 0;

  const preview = useMutation({
    mutationFn: () =>
      api.previewFilter({ subjectId, filter, episodeOffset: offsetNumber })
  });

  // Re-run the preview whenever the filter settles, so the match list always
  // reflects what is actually on screen.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => preview.mutate(), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, JSON.stringify(filter), offsetNumber]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        title: title.trim(),
        libraryFolder: libraryFolder.trim(),
        season: Number(season) || 0,
        episodeOffset: offsetNumber,
        filter,
        autoDownload
      };
      return existing
        ? api.updateSubscription(existing.id, body)
        : api.createSubscription({
            ...body,
            subjectId,
            enabled: true,
            backfillDays: Number(backfillDays) || 0
          });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['anime', subjectId] });
      onClose();
    },
    onError: (err: Error) => setError(err.message)
  });

  const result = preview.data;
  const episodeSummary = useMemo(() => {
    if (!result?.episodes.length) return null;
    const min = result.episodes[0]!;
    const max = result.episodes[result.episodes.length - 1]!;
    return min === max ? `E${min}` : `E${min}–E${max} (${result.episodes.length})`;
  }, [result]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={existing ? `Edit subscription — ${existing.title}` : 'Subscribe'}
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-4">
          <div>
            <Label hint="Used for the Jellyfin series title and episode filenames.">
              Series title
            </Label>
            <Input value={title} onChange={setTitle} />
          </div>

          <div>
            <Label hint="Folder created under LIBRARY_ROOT. Convention: Title (Year).">
              Library folder
            </Label>
            <Input value={libraryFolder} onChange={setLibraryFolder} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label hint="0 files into Specials.">Season</Label>
              <Input type="number" min={0} max={99} value={season} onChange={setSeason} />
            </div>
            <div>
              <Label hint="Subtract from released numbers. Use 12 if a S2 release is numbered 13+.">
                Episode offset
              </Label>
              <Input type="number" value={episodeOffset} onChange={setEpisodeOffset} />
            </div>
          </div>

          <div>
            <Label hint="Pick one to keep episode numbering and quality consistent.">
              Fansub groups
            </Label>
            <TagInput
              value={filter.fansubs ?? []}
              onChange={(fansubs) => setFilter((f) => ({ ...f, fansubs }))}
              placeholder="LoliHouse, ANi"
            />
            {fansubOptions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {fansubOptions.slice(0, 10).map((option) => {
                  const selected = filter.fansubs?.includes(option.name);
                  return (
                    <button
                      key={option.name}
                      onClick={() =>
                        setFilter((f) => ({
                          ...f,
                          fansubs: selected
                            ? (f.fansubs ?? []).filter((n) => n !== option.name)
                            : [...(f.fansubs ?? []), option.name]
                        }))
                      }
                      className={
                        selected
                          ? 'rounded-md bg-brand px-2 py-0.5 text-[11px] text-white'
                          : 'rounded-md bg-ink-800 px-2 py-0.5 text-[11px] text-ink-300 hover:bg-ink-700'
                      }
                    >
                      {option.name}
                      <span className="ml-1 opacity-60">{option.count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label hint="All must appear in the title.">Require keywords</Label>
              <TagInput
                value={filter.keywords ?? []}
                onChange={(keywords) => setFilter((f) => ({ ...f, keywords }))}
                placeholder="1080p, 简体"
              />
            </div>
            <div>
              <Label hint="Any match is rejected.">Exclude</Label>
              <TagInput
                value={filter.exclude ?? []}
                onChange={(exclude) => setFilter((f) => ({ ...f, exclude }))}
                placeholder="繁体, 720p"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-ink-300">
            <input
              type="checkbox"
              checked={autoDownload}
              onChange={(event) => setAutoDownload(event.target.checked)}
              className="size-3.5 accent-[var(--color-brand)]"
            />
            Download new episodes automatically
          </label>

          {!existing && (
            <div>
              <Label hint="0 starts from now. Higher values also grab already-published episodes.">
                Backfill (days)
              </Label>
              <Input type="number" min={0} value={backfillDays} onChange={setBackfillDays} />
            </div>
          )}

          {error && <ErrorNote>{error}</ErrorNote>}

          <div className="flex justify-end gap-2 pt-1">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Subscribe'}
            </Button>
          </div>
        </div>

        {/* Live preview: the filter is only trustworthy if you can see what it picks up. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-ink-300">Matching releases</div>
            {result && (
              <div className="flex items-center gap-1.5">
                <Badge tone={result.total > 0 ? 'brand' : 'warn'}>{result.total} total</Badge>
                {episodeSummary && <Badge tone="success">{episodeSummary}</Badge>}
                {result.unparsed > 0 && <Badge tone="warn">{result.unparsed} unparsed</Badge>}
              </div>
            )}
          </div>

          <div className="h-[26rem] overflow-y-auto rounded-lg border border-ink-800 bg-ink-950/50 p-2">
            {preview.isPending && <Spinner label="Checking AnimeGarden…" />}
            {preview.isError && <ErrorNote>{(preview.error as Error).message}</ErrorNote>}
            {result && result.matches.length === 0 && (
              <div className="p-4 text-center text-xs text-ink-500">
                Nothing matches this filter. Try removing a keyword or fansub.
              </div>
            )}
            {result?.matches.map((match, index) => (
              <div
                key={`${match.title}-${index}`}
                className="border-b border-ink-800/70 px-1.5 py-2 last:border-0"
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {match.episode !== undefined ? (
                    <Badge tone="brand">E{match.episode}</Badge>
                  ) : (
                    <Badge tone="warn">no episode</Badge>
                  )}
                  {match.lowConfidence && (
                    <Badge tone="warn" title="Episode number came from the fallback parser">
                      guessed
                    </Badge>
                  )}
                  {match.resolution && <Badge>{match.resolution}</Badge>}
                  {match.subtitleLanguages?.map((lang) => <Badge key={lang}>{lang}</Badge>)}
                  <span className="text-[11px] text-ink-500">{formatSize(match.size)}</span>
                </div>
                <div className="break-title text-[11px] leading-snug text-ink-300">
                  {match.title}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
