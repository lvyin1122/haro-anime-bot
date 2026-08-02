import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import clsx from 'clsx';

import { api } from '../api';
import { Badge, Card, ErrorNote, Spinner } from '../components/ui';

/** Bangumi's weekday ids are 1=Mon … 7=Sun; JS getDay() is 0=Sun. */
function todayWeekdayId(): number {
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

export function CalendarPage() {
  const { data, isPending, error } = useQuery({
    queryKey: ['calendar'],
    queryFn: api.calendar,
    staleTime: 30 * 60_000
  });

  const today = todayWeekdayId();

  if (isPending) return <Spinner label="Loading airing schedule…" />;
  if (error) return <ErrorNote>{(error as Error).message}</ErrorNote>;

  // Rotate so today comes first — that is what you actually want to see.
  const days = [...(data?.days ?? [])].sort((a, b) => {
    const rank = (id: number) => (id - today + 7) % 7;
    return rank(a.weekday.id) - rank(b.weekday.id);
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold">Airing this week</h1>
        <p className="mt-0.5 text-xs text-ink-500">
          From Bangumi's broadcast calendar. Click a show to see releases and subscribe.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {days.map((day) => (
          <Card key={day.weekday.id} className="p-0">
            <div
              className={clsx(
                'flex items-center justify-between rounded-t-xl px-4 py-2.5',
                day.weekday.id === today ? 'bg-brand/15' : 'bg-ink-800/40'
              )}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{day.weekday.cn}</span>
                <span className="text-[11px] text-ink-500">{day.weekday.en}</span>
              </div>
              {day.weekday.id === today && <Badge tone="brand">today</Badge>}
            </div>

            <div className="max-h-80 overflow-y-auto">
              {day.items.map((item) => (
                <Link
                  key={item.id}
                  to="/anime/$subjectId"
                  params={{ subjectId: String(item.id) }}
                  className="flex items-center gap-2.5 border-b border-ink-800/60 px-3 py-2 last:border-0 hover:bg-ink-800/40"
                >
                  {item.image ? (
                    <img src={item.image} alt="" className="h-12 w-9 shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-12 w-9 shrink-0 rounded bg-ink-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-ink-300" title={item.title}>
                      {item.title}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1">
                      {item.score !== undefined && item.score > 0 && (
                        <span className="text-[10px] text-ink-500">★ {item.score.toFixed(1)}</span>
                      )}
                      {item.subscribed && <Badge tone="success">subscribed</Badge>}
                    </div>
                  </div>
                </Link>
              ))}
              {day.items.length === 0 && (
                <div className="px-3 py-6 text-center text-xs text-ink-500">Nothing airing.</div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
