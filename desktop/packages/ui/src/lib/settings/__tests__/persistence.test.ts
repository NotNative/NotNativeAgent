// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Settings persistence engine (doc 14 §F.3): cached GET + in-flight dedupe,
 * debounced single-shot PUT with echo suppression, unknown/derived filtering,
 * save-state machine (error auto-reset), synced-event grades, mirror index
 * eviction, and the one-per-runtime device-seed marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../runtime-fetch.ts';
import {
  __resetEngineForTests,
  SETTINGS_DEBOUNCE_MS,
  SETTINGS_SYNCED_EVENT,
  currentSurfaceKind,
  fetchSettingsDocument,
  flushPendingSettings,
  onSettingsSynced,
  pendingSettingsSnapshot,
  startSettingsSync,
  updateDesktopSettings,
} from '../persistence.ts';
import { getSettingsSaveState, subscribeSettingsSaveState } from '../save-state.ts';

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const WEB_DOC = {
  surface: 'web',
  chatRenderMode: 'live',
  fontSize: 110,
  hasDesktopUiPassword: false, // computed: passes through, unregistered? no — registry key
  themeVariant: 'dark', // derived: dropped by the client parser
  legacyUnknownKey: 'dropped', // unknown: dropped by the client parser
};

beforeEach(() => {
  __resetEngineForTests();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ ...WEB_DOC }));
  delete window.__NOTNATIVE_RUNTIME_KEY__;
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchSettingsDocument (§F.3 GET machinery)', () => {
  it('rides ?surface=, caches for the TTL, and coalesces parallel calls', async () => {
    const first = await fetchSettingsDocument('web', true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/config/settings?surface=web');
    expect(first?.fontSize).toBe(110);
    expect(first?.themeVariant).toBe('dark'); // derived IS collected (sent-only: §F.2)
    expect(first?.legacyUnknownKey).toBeUndefined(); // unknown dropped
    await fetchSettingsDocument('web'); // TTL hit: no new call
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await Promise.all([fetchSettingsDocument('web', true), fetchSettingsDocument('web', true)]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // in-flight dedupe
  });

  it('answers null on failure — never an empty document', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    expect(await fetchSettingsDocument('web', true)).toBeNull();
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await fetchSettingsDocument('web', true)).toBeNull();
  });

  it('classifies the runtime surface from the platform probes', () => {
    expect(['web', 'desktop', 'mobile', 'vscode']).toContain(currentSurfaceKind());
  });

  it('filters whole write categories per the registry flags (§F.2)', () => {
    updateDesktopSettings({
      chatRenderMode: 'sorted',        // writable profile key
      hasDesktopUiPassword: true,      // computed → dropped
      desktopUiPassword: 'sneaky',     // secret: accepted on write, never returned (§F.2)
      alwaysShowScrollbars: true,      // LOCAL_DEVICE (device scope) → dropped
      mobileKeyboardMode: 'native',    // device scope → dropped
      desktopSplashColors: {},         // owner desktop-shell → dropped
      themeVariant: 'dark',            // derived: sent-only, never written
      fontSize: '120x',                // invalid value → dropped by the client sanitizer
    });
    expect(Object.keys(pendingSettingsSnapshot()).sort()).toEqual(['chatRenderMode', 'desktopUiPassword']);
  });
});

describe('updateDesktopSettings + flush (§F.3 PUT pipeline)', () => {
  it('filters unknown/derived keys; debounces the remainder into ONE keepalive PUT', async () => {
    const accepted = updateDesktopSettings({ chatRenderMode: 'sorted', themeVariant: 'light', unknownFreshKey: 1 });
    expect(accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain('/api/config/settings?surface=');
    expect(JSON.parse(init.body as string)).toEqual({ chatRenderMode: 'sorted' });
    expect(init.keepalive).toBe(true);
    expect(getSettingsSaveState()).toBe('idle');
  });

  it('suppresses echoes: values equal to the known server document never PUT', async () => {
    await startSettingsSync({ bootstrap: true, adoptTheme: false });
    expect(updateDesktopSettings({ chatRenderMode: 'live' })).toBe(false); // == known
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS + 50);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the sync GET
  });

  it('a toggle-back to the known value cancels the pending write', async () => {
    await startSettingsSync({ bootstrap: true, adoptTheme: false }); // known fontSize 110
    updateDesktopSettings({ fontSize: 120 });
    updateDesktopSettings({ fontSize: 110 });
    const flushed = await flushPendingSettings(); // nothing pending → immediate true
    expect(flushed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports saving→idle and sets error on failed flush with a 6 s reset', async () => {
    const states: string[] = [];
    const off = subscribeSettingsSaveState((saveState) => states.push(saveState));
    updateDesktopSettings({ chatRenderMode: 'sorted' });
    fetchMock.mockResolvedValue(jsonResponse({}, false));
    await vi.advanceTimersByTimeAsync(SETTINGS_DEBOUNCE_MS);
    expect(getSettingsSaveState()).toBe('error');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(getSettingsSaveState()).toBe('idle'); // auto-reset
    off();
  });
});

describe('sync grades + local artifacts (§F.3 mirrors & seeds)', () => {
  it('emits the synced event with bootstrap/adoptTheme grades', async () => {
    const seen: { bootstrap: boolean; adoptTheme: boolean }[] = [];
    const off = onSettingsSynced((detail) => seen.push({ bootstrap: detail.bootstrap, adoptTheme: detail.adoptTheme }));
    const events: CustomEvent[] = [];
    window.addEventListener(SETTINGS_SYNCED_EVENT, (event) => events.push(event as CustomEvent));
    await startSettingsSync({ bootstrap: true, adoptTheme: true });
    expect(seen).toEqual([{ bootstrap: true, adoptTheme: true }]);
    expect(events.length).toBe(1);
    off();
  });

  it('writes the per-runtime mirror without secret/computed/derived keys', async () => {
    window.__NOTNATIVE_RUNTIME_KEY__ = 'url:http://one.test';
    await startSettingsSync({ bootstrap: true, adoptTheme: false });
    const mirror = JSON.parse(window.localStorage.getItem('notnative.settingsMirror.v2:url%3Ahttp%3A%2F%2Fone.test')!);
    expect(mirror.chatRenderMode).toBe('live');
    expect(mirror.hasDesktopUiPassword).toBeUndefined(); // computed not mirrored
    expect(mirror.themeVariant).toBeUndefined(); // derived not mirrored
    const index = JSON.parse(window.localStorage.getItem('notnative.settingsMirror.v2.index')!);
    expect(index).toEqual(['url:http://one.test']);
  });

  it('caps the mirror index at five runtime keys with eviction', async () => {
    for (let round = 0; round < 7; round += 1) {
      window.__NOTNATIVE_RUNTIME_KEY__ = `url:http://r${round}.test`;
      await startSettingsSync({ bootstrap: true, adoptTheme: false });
    }
    const index = JSON.parse(window.localStorage.getItem('notnative.settingsMirror.v2.index')!) as string[];
    expect(index.length).toBe(5);
    expect(index[0]).toBe('url:http://r2.test'); // r0/r1 evicted
    expect(window.localStorage.getItem('notnative.settingsMirror.v2:url%3Ahttp%3A%2F%2Fr0.test')).toBeNull();
    expect(index.at(-1)).toBe('url:http://r6.test');
  });

  it('seeds device keys once per runtime via the marker file', async () => {
    window.__NOTNATIVE_RUNTIME_KEY__ = 'url:http://seed.test';
    fetchMock.mockResolvedValue(jsonResponse({ chatRenderMode: 'live', inputBarOffset: 35, hasDesktopUiPassword: false }));
    await startSettingsSync({ bootstrap: true, adoptTheme: false });
    const marker = window.localStorage.getItem('notnative.deviceSeeded.v1:url%3Ahttp%3A%2F%2Fseed.test');
    expect(marker).toBeTruthy(); // device-scope field present → marker stamped
    await startSettingsSync({ bootstrap: false, adoptTheme: false });
    const markers = Object.keys(window.localStorage).filter((key) => key.startsWith('notnative.deviceSeeded'));
    expect(markers.length).toBe(1);
  });
});
