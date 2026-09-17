// SPDX-License-Identifier: Apache-2.0
/**
 * P5-3 gates (doc 14 §F.2–F.4 + doc 03 §5.6): registry-gated settings store —
 * seed-once from settings.json, surface-kind resolution, per-surface writes,
 * secret/computed/local/owner gates, unparseable-preferences discipline,
 * notnative-route unification, and the fs write no-op (P4-3 carry-over).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p53-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
const origin = 'http://test.local';

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

function theApp(): App {
  if (!appInstance) throw new Error('app not initialized; beforeAll must run first');
  return appInstance;
}

beforeAll(async () => {
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  const created = createApp();
  appInstance = { fetch: (request: Request) => Promise.resolve(created.fetch(request)) };
});

async function call(path: string, init?: RequestInit): Promise<Response> {
  return theApp().fetch(new Request(`${origin}${path}`, init));
}

async function putSettings(patch: object, query = ''): Promise<Response> {
  return call(`/api/config/settings${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

function readData(name: string): string {
  return readFileSync(joinPath(isolatedDataDir, name), 'utf8');
}

describe('settings split store (§F.3)', () => {
  it('seeds preferences.json from settings.json once, registered keys only', async () => {
    writeFileSync(joinPath(isolatedDataDir, 'settings.json'), JSON.stringify({
      chatRenderMode: 'live',
      legacyUnknownKey: 123,
    }));
    const body = await (await call('/api/config/settings?surface=web')).json() as {
      chatRenderMode?: string; legacyUnknownKey?: unknown; hasDesktopUiPassword?: boolean; surface: string;
    };
    expect(body.chatRenderMode).toBe('live'); // seeded value resolves
    expect(body.legacyUnknownKey).toBeUndefined(); // unregistered never surfaces
    expect(body.hasDesktopUiPassword).toBeUndefined(); // desktop-surface computed only
    expect(body.surface).toBe('web');
    const prefs = JSON.parse(readData('preferences.json')) as { version: number; fields: Record<string, { value: unknown }> };
    expect(prefs.version).toBe(1);
    expect(prefs.fields.chatRenderMode?.value).toBe('live');
    expect(prefs.fields.legacyUnknownKey).toBeUndefined();
  });

  it('stores secrets but never returns them; computed tracks the state', async () => {
    await putSettings({ desktopUiPassword: 'hunter2' }, '?surface=desktop');
    const doc = await (await call('/api/config/settings?surface=desktop')).json() as {
      desktopUiPassword?: string; hasDesktopUiPassword?: boolean;
    };
    expect(doc.desktopUiPassword).toBeUndefined(); // secret never returned (§F.2)
    expect(doc.hasDesktopUiPassword).toBe(true); // computed reflects the store
    const prefs = JSON.parse(readData('preferences.json')) as { fields: Record<string, { value?: unknown }> };
    expect(prefs.fields.desktopUiPassword?.value).toBe('hunter2');
  });

  it('per-surface writes go to fields[key].surfaces[kind]; base stays', async () => {
    await putSettings({ terminalFontSize: 12 });
    await putSettings({ terminalFontSize: 11 }, '?surface=desktop');
    const web = await (await call('/api/config/settings?surface=web')).json() as { terminalFontSize?: number };
    const desktop = await (await call('/api/config/settings?surface=desktop')).json() as { terminalFontSize?: number };
    expect(web.terminalFontSize).toBe(12);
    expect(desktop.terminalFontSize).toBe(11);
    const prefs = JSON.parse(readData('preferences.json')) as { fields: Record<string, { value?: unknown; surfaces?: Record<string, { value: unknown }> }> };
    expect(prefs.fields.terminalFontSize?.value).toBeNull(); // kind values NEVER on base (§F.2)
    expect(prefs.fields.terminalFontSize?.surfaces?.web?.value).toBe(12);
    expect(prefs.fields.terminalFontSize?.surfaces?.desktop?.value).toBe(11);
  });

  it('gate drops computed, local, device, owner and unknown keys from PUTs', async () => {
    await putSettings({
      hasDesktopUiPassword: true,
      alwaysShowScrollbars: true,
      mobileKeyboardMode: 'native',
      desktopSplashColors: { a: '#000' },
      notInRegistry: 1,
    });
    const prefs = JSON.parse(readData('preferences.json')) as { fields: Record<string, unknown> };
    expect(prefs.fields.hasDesktopUiPassword).toBeUndefined();
    expect(prefs.fields.alwaysShowScrollbars).toBeUndefined();
    expect(prefs.fields.mobileKeyboardMode).toBeUndefined();
    expect(prefs.fields.desktopSplashColors).toBeUndefined();
    expect(Object.keys(prefs.fields).some((key) => key.startsWith('notInRegistry'))).toBe(false);
  });

  it('keeps an unparseable preferences.json untouched; routes still answer', async () => {
    const prior = readData('preferences.json');
    writeFileSync(joinPath(isolatedDataDir, 'preferences.json'), '{corrupt');
    const before = readData('preferences.json');
    const response = await putSettings({ chatRenderMode: 'sorted' });
    expect(response.status).toBe(200);
    expect(readData('preferences.json')).toBe(before); // never rewritten (§F.3)
    const mirrored = JSON.parse(readData('settings.json')) as { chatRenderMode?: string };
    expect(mirrored.chatRenderMode).toBe('sorted'); // legacy mirror path applied
    writeFileSync(joinPath(isolatedDataDir, 'preferences.json'), prior); // restore for later tests
  });

  it('unknown surface kinds fall back to web; notnative route rides the same store', async () => {
    await putSettings({ sessionRecapEnabled: false }, '?surface=toaster');
    const viaConfig = await (await call('/api/config/settings')).json() as { sessionRecapEnabled?: boolean };
    expect(viaConfig.sessionRecapEnabled).toBe(false);
    const viaNative = await (await call('/api/notnative/settings')).json() as { settings: { sessionRecapEnabled?: boolean }; source: string };
    expect(viaNative.source).toBe('web');
    expect(viaNative.settings.sessionRecapEnabled).toBe(false);
    await call('/api/notnative/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionSuggestionEnabled: true }),
    });
    const after = await (await call('/api/config/settings')).json() as { sessionSuggestionEnabled?: boolean };
    expect(after.sessionSuggestionEnabled).toBe(true);
  });

  it('surface-restricted keys write on their kinds and hide elsewhere', async () => {
    await putSettings({ pwaAppName: 'NND PWA' });
    const web = await (await call('/api/config/settings?surface=web')).json() as { pwaAppName?: string };
    const desktop = await (await call('/api/config/settings?surface=desktop')).json() as { pwaAppName?: string };
    expect(web.pwaAppName).toBe('NND PWA');
    expect(desktop.pwaAppName).toBeUndefined(); // surfaces ['web'] filtered from desktop GET
    const stray = await putSettings({ pwaAppName: 'shady' }, '?surface=desktop');
    expect((await stray.json()) as { settings: { pwaAppName?: string } }).toMatchObject({ settings: {} });
    const prefs = JSON.parse(readData('preferences.json')) as { fields: Record<string, { value?: unknown }> };
    expect(prefs.fields.pwaAppName?.value).not.toBe('shady'); // desktop write dropped
  });

  it('surface resolution: ?surface= wins over nothing; junk falls back to web', async () => {
    const { resolveSurfaceKind } = await import('../lib/settings-gate.ts');
    expect(resolveSurfaceKind('desktop', 'mobile')).toBe('desktop');
    expect(resolveSurfaceKind(undefined, 'mobile')).toBe('mobile'); // bridge route header fallback
    expect(resolveSurfaceKind('toaster', undefined)).toBe('web');
    expect(resolveSurfaceKind(undefined, 'grey')).toBe('web');
  });
});

describe('fs write no-op (P4-3 carry-over, §5.14)', () => {
  const workspace = mkdtempSync(`${tmpdir()}${sep}nnd-fs-`);
  const scope = `?directory=${encodeURIComponent(workspace)}`;

  it('identical content skips the atomic rewrite and reports unchanged', async () => {
    const first = await call(`/api/fs/write${scope}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'noop.txt', content: 'same\n' }),
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as { unchanged?: boolean }).toEqual({ success: true, path: joinPath(workspace, 'noop.txt') });
    const before = readFileSync(joinPath(workspace, 'noop.txt')).toString('base64');
    const second = await call(`/api/fs/write${scope}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'noop.txt', content: 'same\n' }),
    });
    const noopBody = (await second.json()) as { unchanged?: boolean };
    expect(noopBody.unchanged).toBe(true);
    expect(readFileSync(joinPath(workspace, 'noop.txt')).toString('base64')).toBe(before);
  });

  it('changed content still rewrites', async () => {
    const response = await call(`/api/fs/write${scope}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'noop.txt', content: 'different\n' }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { unchanged?: boolean };
    expect(body.unchanged).toBeUndefined();
    expect(readFileSync(joinPath(workspace, 'noop.txt'), 'utf8')).toBe('different\n');
    rmSync(workspace, { recursive: true, force: true });
  });
});
