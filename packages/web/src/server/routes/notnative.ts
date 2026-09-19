// SPDX-License-Identifier: Apache-2.0
/**
 * /api/notnative/* and other server-owned UI routes (doc 03 owns the full table;
 * P0 ships the boot-critical subset only).
 */
import { Hono, type Context } from 'hono';
import { ENV } from '../env.ts';
import { publishControlEvent, subscribeControlEvents } from '../lib/bus.ts';
import { CONTROL_EVENTS } from '../lib/harnessNaming.ts';
import { resolveSurfaceKind } from '../lib/settings-gate.ts';
import { readMergedSettings, writeSettingsPatch } from '../lib/settings-store.ts';
import { wireTunnelSettings } from '../lib/tunnels/tunnel-settings.ts';
import { getTunnelService } from '../lib/tunnels/tunnel-service.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { sseResponse } from '../lib/sse.ts';

const CONTROL_HEARTBEAT_MS = 45_000;
const SERVER_STARTED_AT = new Date().toISOString();

export function createNotNativeRoutes(): Hono {
  const app = new Hono();

  // SSE control stream (§5.4): unnamed data frames `{type:"notnative:*", properties}`
  // — onmessage-compatible; comment heartbeats keep intermediaries alive only.
  app.get('/api/notnative/events', (c) => controlStream(c));
  // §F.3 bridge: the RuntimeAPIs settings.load/save pair rides the SAME
  // registry-gated store as /api/config/settings (one storage, no drift).
  app.get('/api/notnative/settings', async (c) => {
    const kind = resolveSurfaceKind(undefined, c.req.header('x-nnd-surface'));
    return c.json({ settings: readMergedSettings(kind), source: 'web' });
  });
  app.put('/api/notnative/settings', async (c) => {
    const kind = resolveSurfaceKind(undefined, c.req.header('x-nnd-surface'));
    const body = await readJsonBodyBounded(c.req.raw, 512 * 1024);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'settings patch must be a JSON object' }, 400);
    }
    const outcome = writeSettingsPatch(body as Record<string, unknown>, kind);
    wireTunnelSettings(body as Record<string, unknown>); // §4.5 runtime TTL re-clamps ride settings writes
    return c.json({ settings: outcome.settings, source: 'web' });
  });
  // §5 doc 03 system info row: runtime/platform/pid/started/port + the live
  // tunnel URL. GATED in NND (the original served it pub — deviation noted
  // in the ledger; the anonymous /health surface carries the same
  // non-sensitive version/serverId subset).
  app.get('/api/system/info', (c) => {
    let tunnelUrl: string | null = null;
    try {
      tunnelUrl = getTunnelService().status().url ?? null;
    } catch {
      tunnelUrl = null; // service singleton not seeded yet (early boot/tests)
    }
    return c.json({
      openchamberVersion: ENV.version,
      runtime: process.env?.NOTNATIVE_RUNTIME ?? 'web',
      pid: process.pid,
      startedAt: SERVER_STARTED_AT,
      port: ENV.port,
      tunnelUrl,
    });
  });
  app.get('/api/notnative/update-check', (c) => updateCheck(c));
  app.post('/api/notnative/update-install', (c) =>
    c.json({ error: 'self-update is not available in this build', code: 'UPDATE_UNSUPPORTED' }, 400),
  );
  // PWA manifest endpoint (client builds the <link> against this; fallback blob exists)
  app.get('/manifest.webmanifest', (c) => pwaManifest(c));
  return app;
}

function controlStream(c: Context): Response {
  return sseResponse((send) => {
    const unsubscribe = subscribeControlEvents((event) =>
      send({ data: JSON.stringify({ type: event.type, properties: event.payload ?? {} }) }),
    );
    send({ data: JSON.stringify({ type: CONTROL_EVENTS.eventStreamReady, properties: {} }) });
    const heartbeat = setInterval(() => send({ comment: 'heartbeat' }), CONTROL_HEARTBEAT_MS);
    return () => {
      unsubscribe();
      clearInterval(heartbeat);
    };
  }, c.req.raw.signal);
}

function updateCheck(c: Context): Response {
  // UI update polling contract (doc 01 §4.5). Self-update machinery lands with P4/P12.
  return c.json({
    available: false,
    currentVersion: ENV.version,
    nextSuggestedCheckInSec: 3600,
  });
}

function pwaManifest(c: Context): Response {
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
}

export { publishControlEvent };
