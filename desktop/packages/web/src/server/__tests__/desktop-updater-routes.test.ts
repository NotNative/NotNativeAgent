// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const origin = 'http://test.local';
type App = { fetch: (request: Request) => Promise<Response> };
let app: App;
const priorPassword = process.env.NOTNATIVE_UI_PASSWORD;
afterEach(() => {
  if (priorPassword === undefined) delete process.env.NOTNATIVE_UI_PASSWORD;
  else process.env.NOTNATIVE_UI_PASSWORD = priorPassword;
});

beforeAll(async () => {
  delete process.env.NOTNATIVE_UI_PASSWORD;
  registerHarnessAdapter(mockHarness);
  const { createApp } = await import('../app.ts');
  const created = createApp({ desktopUpdater: {
    check: async () => ({ available: true, currentVersion: '20260930-77', version: '20260930-78', body: 'Release notes', date: null }),
    download: async () => undefined,
    install: async () => undefined,
  } });
  app = { fetch: (request) => Promise.resolve(created.fetch(request)) };
});

function call(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${origin}${path}`, init));
}

describe('authenticated desktop updater routes', () => {
  it('requires the existing API authentication gate when UI password protection is enabled', async () => {
    process.env.NOTNATIVE_UI_PASSWORD = 'updater-route-test';
    const response = await call('/api/openchamber/update-check');
    expect(response.status).toBe(401);
  });

  it('returns native release metadata on the documented polling route', async () => {
    const response = await call('/api/openchamber/update-check?appType=desktop-electron&updateStatus=true');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true, currentVersion: '20260930-77', version: '20260930-78',
      body: 'Release notes', updateOwner: 'electron-updater', updateStatus: 'idle',
      nextSuggestedCheckInSec: 3600,
    });
  });

  it('acknowledges only after download, then schedules install after the response', async () => {
    const calls: string[] = [];
    const { createApp } = await import('../app.ts');
    const created = createApp({ desktopUpdater: {
      check: async () => { calls.push('check'); return { available: true, currentVersion: '77', version: '78' }; },
      download: async () => { calls.push('download'); },
      install: async () => { calls.push('install'); },
    } });
    const response = await created.fetch(new Request(`${origin}/api/openchamber/update-install`, { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, version: '78', autoRestart: true, updateOwner: 'electron-updater' });
    expect(calls).toEqual(['check', 'download']);
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(calls).toEqual(['check', 'download', 'install']);
  });

  it('rejects duplicate installs while one is restarting and reports late failures to status polling', async () => {
    const install = vi.fn(async () => { throw new Error('signature rejected'); });
    const { createApp } = await import('../app.ts');
    const created = createApp({ desktopUpdater: {
      check: async () => ({ available: true, currentVersion: '77', version: '78' }),
      download: async () => undefined,
      install,
    } });
    const request = () => created.fetch(new Request(`${origin}/api/openchamber/update-install`, { method: 'POST' }));
    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 125));
    expect(install).toHaveBeenCalledTimes(1);
    const status = await created.fetch(new Request(`${origin}/api/openchamber/update-check?updateStatus=true`));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ code: 'DESKTOP_UPDATE_RESTART_FAILED', error: 'signature rejected' });
  });

  it('does not run a mutating updater check while a download is in progress', async () => {
    let resolveDownload!: () => void;
    const download = vi.fn(() => new Promise<void>((resolve) => { resolveDownload = resolve; }));
    const check = vi.fn(async () => ({ available: true, currentVersion: '77', version: '78' }));
    const { createApp } = await import('../app.ts');
    const created = createApp({ desktopUpdater: { check, download, install: async () => undefined } });
    const install = created.fetch(new Request(`${origin}/api/openchamber/update-install`, { method: 'POST' }));
    while (download.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await created.fetch(new Request(`${origin}/api/openchamber/update-check?updateStatus=true`));
    expect(check).toHaveBeenCalledTimes(1);
    expect(await status.json()).toMatchObject({ updateStatus: 'starting', targetVersion: '78' });
    resolveDownload();
    expect((await install).status).toBe(200);
  });

  it('surfaces updater errors reported after the install promise has settled', async () => {
    let lateError: string | null = null;
    const clearInstallError = vi.fn(() => { lateError = null; });
    const { createApp } = await import('../app.ts');
    const created = createApp({ desktopUpdater: {
      check: async () => ({ available: true, currentVersion: '77', version: '78' }),
      download: async () => undefined,
      install: async () => undefined,
      getInstallError: () => lateError,
      clearInstallError,
    } });
    expect((await created.fetch(new Request(`${origin}/api/openchamber/update-install`, { method: 'POST' }))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 125));
    lateError = 'installer exited late';
    const status = await created.fetch(new Request(`${origin}/api/openchamber/update-check?updateStatus=true`));
    expect(status.status).toBe(503);
    expect(await status.json()).toEqual({ code: 'DESKTOP_UPDATE_RESTART_FAILED', error: 'installer exited late' });
    expect((await created.fetch(new Request(`${origin}/api/openchamber/update-install`, { method: 'POST' }))).status).toBe(200);
    expect(clearInstallError).toHaveBeenCalledTimes(2);
    const retryStatus = await created.fetch(new Request(`${origin}/api/openchamber/update-check?updateStatus=true`));
    expect(retryStatus.status).toBe(200);
  });

  it('keeps the route inert when the embedded host has no native updater', async () => {
    const { createApp } = await import('../app.ts');
    const created = createApp();
    expect(await (await created.fetch(new Request(`${origin}/api/openchamber/update-check`))).json())
      .toMatchObject({ available: false, currentVersion: expect.any(String) });
    expect((await created.fetch(new Request(`${origin}/api/openchamber/update-install`, { method: 'POST' }))).status).toBe(400);
  });
});
