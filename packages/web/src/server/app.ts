import { Hono } from 'hono';
import { ENV } from './env.ts';
import { getHarnessAdapter } from './harness/adapter.ts';
import { createStaticHandler, DIST_DIR } from './lib/static.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createNotNativeRoutes } from './routes/notnative.ts';

export function createApp() {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      name: ENV.appName,
      version: ENV.version,
      runtime: process.env?.NOTNATIVE_RUNTIME ?? 'web',
      // HP-9: keep the field name — the UI feature-flag wiring depends on it
      planModeExperimentalEnabled: ENV.planModeExperimentalEnabled,
    }),
  );

  app.route('/', createAuthRoutes());
  app.route('/', createNotNativeRoutes());

  // Harness proxy: everything under /api goes through the seam (HP-1).
  app.all('/api/*', async (c) => {
    try {
      return await getHarnessAdapter().handle(c.req.raw);
    } catch (error) {
      return c.json(
        { error: { message: `harness request failed: ${String(error)}` } },
        502,
      );
    }
  });

  // Static UI (production builds; dev is served by Vite)
  const serveStatic = createStaticHandler(DIST_DIR);
  app.all('*', async (c, next) => {
    const response = await serveStatic(c.req.raw);
    if (response) return response;
    return next();
  });

  app.notFound((c) =>
    c.json({ error: { message: `not found: ${new URL(c.req.raw.url).pathname}` } }, 404),
  );

  return app;
}
