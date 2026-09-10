import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider
} from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Layout } from './components/Layout';
import { I18nProvider } from './i18n';
import { AnimePage } from './routes/AnimePage';
import { CalendarPage } from './routes/CalendarPage';
import { DashboardPage } from './routes/DashboardPage';
import { DownloadsPage } from './routes/DownloadsPage';
import { LibraryPage } from './routes/LibraryPage';
import { SearchPage } from './routes/SearchPage';
import { SettingsPage } from './routes/SettingsPage';
import { SubscriptionPage } from './routes/SubscriptionPage';
import { SubscriptionsPage } from './routes/SubscriptionsPage';
import { WatchPage } from './routes/WatchPage';
import './styles.css';

const rootRoute = createRootRoute({ component: Layout });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/search',
    component: SearchPage,
    validateSearch: (search: Record<string, unknown>) => ({
      q: typeof search.q === 'string' ? search.q : undefined,
      tab: search.tab === 'resources' ? ('resources' as const) : ('anime' as const)
    })
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/calendar', component: CalendarPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/anime/$subjectId',
    component: AnimePage
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/subscriptions',
    component: SubscriptionsPage
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/subscriptions/$id',
    component: SubscriptionPage
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/library', component: LibraryPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/watch/$fileId', component: WatchPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/downloads', component: DownloadsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage })
];

const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // AnimeGarden and Bangumi data changes on the order of minutes, not
      // seconds; refetching on every window focus is wasted work on a Pi.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>
);
