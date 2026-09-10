import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import clsx from 'clsx';
import {
  CalendarDays,
  Download,
  LayoutDashboard,
  PlayCircle,
  Rss,
  Search,
  Settings as SettingsIcon
} from 'lucide-react';

import { api } from '../api';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/calendar', label: 'Airing', icon: CalendarDays },
  { to: '/subscriptions', label: 'Subscriptions', icon: Rss },
  { to: '/library', label: 'Library', icon: PlayCircle },
  { to: '/downloads', label: 'Downloads', icon: Download },
  { to: '/settings', label: 'Settings', icon: SettingsIcon }
] as const;

/**
 * Haro: a green sphere with two lit eyes, a seam across the middle and ear
 * panels that flip open. Kept identical to public/favicon.svg — the tab icon
 * and the header mark being the same shape is most of what makes a small app
 * feel like one thing.
 */
function HaroMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className}>
      <rect x="-1" y="9.5" width="7" height="13" rx="3" fill="var(--color-brand-soft)" />
      <rect x="26" y="9.5" width="7" height="13" rx="3" fill="var(--color-brand-soft)" />
      <circle cx="16" cy="16" r="14" fill="var(--color-brand)" />
      <path
        d="M2.7 17.6h26.6"
        stroke="var(--color-ink-950)"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.75"
      />
      <circle cx="10.6" cy="12.2" r="3.7" fill="var(--color-ink-950)" />
      <circle cx="21.4" cy="12.2" r="3.7" fill="var(--color-ink-950)" />
      <circle cx="10.6" cy="12.2" r="1.9" fill="var(--color-eye)" />
      <circle cx="21.4" cy="12.2" r="1.9" fill="var(--color-eye)" />
    </svg>
  );
}

export function Layout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Drives the header dot; a slow poll is enough to notice qBittorrent dying.
  const health = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 60_000,
    staleTime: 30_000
  });

  // Unwatched count on the Library tab — the "anything new for me?" glance.
  const ready = useQuery({
    queryKey: ['ready', 40],
    queryFn: () => api.ready(40),
    refetchInterval: 60_000
  });

  const degraded = health.data && health.data.status !== 'ok';
  const unwatched = ready.data?.items.filter((item) => !item.played).length ?? 0;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <HaroMark className="size-7 shrink-0" />
            <span className="hidden text-sm font-semibold sm:block">Haro</span>
          </Link>

          <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {NAV.map(({ to, label, icon: Icon }) => {
              const active = to === '/' ? pathname === '/' : pathname.startsWith(to);
              return (
                <Link
                  key={to}
                  to={to}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition',
                    active
                      ? 'bg-ink-800 text-ink-100'
                      : 'text-ink-500 hover:bg-ink-900 hover:text-ink-300'
                  )}
                >
                  <Icon className="size-3.5" />
                  <span className="hidden md:block">{label}</span>
                  {to === '/library' && unwatched > 0 && (
                    <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold text-white">
                      {unwatched}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <Link
            to="/settings"
            title={
              health.data
                ? health.data.services.map((s) => `${s.name}: ${s.detail}`).join('\n')
                : 'Checking services…'
            }
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] text-ink-500 hover:bg-ink-900"
          >
            <span
              className={clsx(
                'size-2 rounded-full',
                !health.data ? 'bg-ink-600' : degraded ? 'bg-eye' : 'bg-brand'
              )}
            />
            <span className="hidden lg:block">
              {!health.data ? 'checking' : degraded ? 'degraded' : 'healthy'}
            </span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
