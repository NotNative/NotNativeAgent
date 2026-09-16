/**
 * /api/notnative/* and other server-owned UI routes (doc 03 owns the full table;
 * P0 ships the boot-critical subset only).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { ENV } from '../env.ts';
import { publishControlEvent, subscribeControlEvents } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { sseResponse } from '../lib/sse.ts';

const CONTROL_HEARTBEAT_MS = 45_000;

async function readSettings(): Promise<Record<string, unknown>> {
  try {
    const file = path.join(ENV.dataDir, 'settings.json');
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(ENV.dataDir, { recursive: true });
  await writeFile(path.join(ENV.dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

export function createNotNativeRoutes(): Hono {
  const app = new Hono();

  // SSE control stream (§5.4): unnamed data frames `{type:"notnative:*", properties}`
  // — onmessage-compatible; comment heartbeats keep intermediaries alive only.
  app.get('/api/notnative/events', (c) =>
    sseResponse((send) => {
      const unsubscribe = subscribeControlEvents((event) =>
        send({ data: JSON.stringify({ type: event.type, properties: event.payload ?? {} }) }),
      );
      send({ data: JSON.stringify({ type: CONTROL_EVENTS.eventStreamReady, properties: {} }) });
      const heartbeat = setInterval(() => send({ comment: 'heartbeat' }), CONTROL_HEARTBEAT_MS);
      return () => {
        unsubscribe();
        clearInterval(heartbeat);
      };
    }, c.req.raw.signal),
  );

  app.get('/api/notnative/settings', async (c) =>
    c.json({ settings: await readSettings(), source: 'web' }),
  );

  app.put('/api/notnative/settings', async (c) => {
    const patch = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const current = await readSettings();
    const merged = { ...current, ...patch };
    await writeSettings(merged);
    return c.json({ settings: merged, source: 'web' });
  });

  // UI update polling contract (doc 01 §4.5). Self-update machinery lands with P4/P12.
  app.get('/api/notnative/update-check', (c) =>
    c.json({
      available: false,
      currentVersion: ENV.version,
      nextSuggestedCheckInSec: 3600,
    }),
  );
  app.post('/api/notnative/update-install', (c) =>
    c.json({ error: 'self-update is not available in this build', code: 'UPDATE_UNSUPPORTED' }, 400),
  );

  // PWA manifest endpoint (client builds the <link> against this; fallback blob exists)
  app.get('/manifest.webmanifest', (c) => {
    const appName = (c.req.query('appName') ?? '').slice(0, 64) || 'NotNativeDesktop';
    const orientation = c.req.query('orientation');
    const manifest = {
      name: appName,
      short_name: appName.length > 30 ? appName.slice(0, 30) : appName,
      description: 'NotNativeDesktop — workspace for running and reviewing agent work',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      display_override: ['window-controls-overlay'],
      ...(orientation === 'portrait-primary' || orientation === 'landscape-primary'
        ? { orientation }
        : {}),
      background_color: '#151313',
      theme_color: '#edb449',
      categories: ['developer', 'tools', 'productivity'],
      lang: 'en',
      icons: [],
      shortcuts: [{ name: 'Appearance Settings', url: '/?settings=appearance' }],
    };
    return c.body(JSON.stringify(manifest), 200, {
      'content-type': 'application/manifest+json',
      'cache-control': 'no-store',
    });
  });

  return app;
}

export { publishControlEvent };
