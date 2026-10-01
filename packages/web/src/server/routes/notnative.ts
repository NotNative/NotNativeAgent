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
import { readMergedSettings, writeSettingsPatchLocked } from '../lib/settings-store.ts';
import { wireTunnelSettings } from '../lib/tunnels/tunnel-settings.ts';
import { getTunnelService } from '../lib/tunnels/tunnel-service.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { sseResponse } from '../lib/sse.ts';

const CONTROL_HEARTBEAT_MS = 45_000;
const SERVER_STARTED_AT = new Date().toISOString();
type DesktopUpdateInfo = { available: boolean; currentVersion: string; version?: string | null; body?: string | null; date?: string | null };
type DesktopUpdater = { check: () => Promise<DesktopUpdateInfo>; download: () => Promise<unknown>; install: () => Promise<unknown>; getInstallError?: () => string | null; clearInstallError?: () => void };

export function createNotNativeRoutes({ desktopUpdater }: { desktopUpdater?: DesktopUpdater } = {}): Hono {
  const app = new Hono();
  let installState: { phase: 'idle' | 'starting' | 'restarting' | 'failed'; version?: string; error?: string } = { phase: 'idle' };

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
    const outcome = await writeSettingsPatchLocked(body as Record<string, unknown>, kind);
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
  for (const path of ['/api/openchamber/update-check', '/api/notnative/update-check']) {
    app.get(path, (c) => updateCheck(c, desktopUpdater, installState));
  }
  for (const path of ['/api/openchamber/update-install', '/api/notnative/update-install']) {
    app.post(path, (c) => installDesktopUpdate(c, desktopUpdater, () => installState, (next) => { installState = next; }));
  }
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

async function updateCheck(c: Context, updater: DesktopUpdater | undefined,
  installState: { phase: 'idle' | 'starting' | 'restarting' | 'failed'; version?: string; error?: string }): Promise<Response> {
  const lateInstallError = updater?.getInstallError?.();
  if (c.req.query('updateStatus') === 'true' && lateInstallError) {
    return c.json({ code: 'DESKTOP_UPDATE_RESTART_FAILED', error: lateInstallError }, 503);
  }
  if (c.req.query('updateStatus') === 'true' && installState.phase === 'failed') {
    return c.json({ code: 'DESKTOP_UPDATE_RESTART_FAILED', error: installState.error ?? 'Desktop update failed' }, 503);
  }
  if (!updater) return c.json({ available: false, currentVersion: ENV.version, nextSuggestedCheckInSec: 3600 });
  // check() mutates electron-updater's shared pendingUpdate. Calling it while
  // download/install is underway can clear or replace the exact artifact the
  // install request is using. Return the active operation's known target.
  if (installState.phase !== 'idle') {
    return c.json({ available: Boolean(installState.version), currentVersion: ENV.version,
      version: installState.version ?? null, updateOwner: 'electron-updater', nextSuggestedCheckInSec: 3600,
      ...(c.req.query('updateStatus') === 'true' ? { updateStatus: installState.phase,
        ...(installState.version ? { targetVersion: installState.version } : {}) } : {}) });
  }
  try {
    const result = await updater.check();
    return c.json({ ...result, currentVersion: result.currentVersion || ENV.version,
      updateOwner: result.available ? 'electron-updater' : undefined,
      nextSuggestedCheckInSec: 3600,
      ...(c.req.query('updateStatus') === 'true' ? { updateStatus: installState.phase,
        ...(installState.version ? { targetVersion: installState.version } : {}) } : {}) });
  } catch (error) {
    return c.json({ code: 'DESKTOP_UPDATE_CHECK_FAILED', error: error instanceof Error ? error.message : 'Desktop update check failed' }, 503);
  }
}

async function installDesktopUpdate(c: Context, updater: DesktopUpdater | undefined,
  getState: () => { phase: 'idle' | 'starting' | 'restarting' | 'failed'; version?: string; error?: string },
  setState: (state: { phase: 'idle' | 'starting' | 'restarting' | 'failed'; version?: string; error?: string }) => void): Promise<Response> {
  if (!updater) return c.json({ error: 'Self-update is not available in this build', code: 'UPDATE_UNSUPPORTED' }, 400);
  const previousLateFailure = updater.getInstallError?.();
  if ((getState().phase === 'starting' || getState().phase === 'restarting') && !previousLateFailure) {
    return c.json({ error: 'A desktop update is already starting', code: 'UPDATE_ALREADY_IN_PROGRESS' }, 409);
  }
  if (previousLateFailure) setState({ phase: 'idle' });
  updater.clearInstallError?.();
  setState({ phase: 'starting' });
  try {
    const result = await updater.check();
    if (!result.available || !result.version) {
      setState({ phase: 'idle' });
      return c.json({ success: false, error: 'No desktop update is available', code: 'UPDATE_NOT_AVAILABLE' }, 409);
    }
    const targetVersion = result.version;
    setState({ phase: 'starting', version: targetVersion });
    await updater.download();
    // Let Hono return the acknowledgement before quitAndInstall can close the
    // embedded host's socket. Subsequent updateStatus polls surface late errors.
    setTimeout(() => {
      setState({ phase: 'restarting', version: targetVersion });
      void updater.install().catch((error: unknown) => {
        setState({ phase: 'failed', version: targetVersion,
          error: error instanceof Error ? error.message : 'Unable to install desktop update' });
      });
    }, 100);
    return c.json({ success: true, message: 'Desktop update is starting', version: targetVersion,
      autoRestart: true, updateOwner: 'electron-updater' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to install desktop update';
    setState({ phase: 'failed', error: message });
    return c.json({ error: message, code: 'DESKTOP_UPDATE_RESTART_FAILED' }, 503);
  }
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
