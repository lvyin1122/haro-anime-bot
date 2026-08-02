import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { config, configWarnings } from './config.ts';
import { db } from './db/index.ts';
import { log } from './log.ts';
import { healthRoutes } from './routes/health.ts';
import { discoverRoutes } from './routes/discover.ts';
import { subscriptionRoutes } from './routes/subscriptions.ts';
import { downloadRoutes } from './routes/downloads.ts';
import { libraryRoutes } from './routes/library.ts';
import { settingsRoutes } from './routes/settings.ts';
import { startScheduler } from './core/scheduler.ts';

const app = new Hono();

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  if (c.req.path.startsWith('/api') && c.req.path !== '/api/health/live') {
    console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`);
  }
});

app.onError((error, c) => {
  log.error('http', `${c.req.method} ${c.req.path} failed`, { error: error.message });
  return c.json({ error: error.message }, 500);
});

const api = new Hono()
  .route('/health', healthRoutes)
  .route('/discover', discoverRoutes)
  .route('/subscriptions', subscriptionRoutes)
  .route('/downloads', downloadRoutes)
  .route('/library', libraryRoutes)
  .route('/settings', settingsRoutes);

app.route('/api', api);
app.notFound((c) =>
  c.req.path.startsWith('/api') ? c.json({ error: 'Not found' }, 404) : serveIndex(c)
);

// --- static SPA ------------------------------------------------------------

const webRoot = config.WEB_ROOT ?? join(process.cwd(), '..', 'web', 'dist');
const indexHtml = join(webRoot, 'index.html');
const hasWeb = existsSync(indexHtml);

async function serveIndex(c: Parameters<Parameters<Hono['notFound']>[0]>[0]) {
  if (!hasWeb) {
    return c.text(
      'UI bundle not found. Run `pnpm --filter ./web build`, or use the Vite dev server on :5173.',
      404
    );
  }
  return c.html(await readFile(indexHtml, 'utf8'));
}

if (hasWeb) {
  app.use('/assets/*', serveStatic({ root: webRoot }));
  app.use('/favicon.svg', serveStatic({ root: webRoot }));
}

// --- boot ------------------------------------------------------------------

db(); // run migrations before anything can query

for (const warning of configWarnings()) log.warn('config', warning);

startScheduler();

serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  log.info('server', `haro listening on http://0.0.0.0:${info.port}`, {
    downloadRoot: config.DOWNLOAD_ROOT,
    libraryRoot: config.LIBRARY_ROOT,
    ui: hasWeb ? 'bundled' : 'not built'
  });
});
