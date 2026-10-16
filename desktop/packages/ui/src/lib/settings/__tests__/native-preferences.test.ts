// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../runtime-fetch.ts';
import { connectNativePreferences, reloadNativePreferences, retryNativePreferences, useNativePreferenceState } from '../native-preferences.ts';
import { useSettingsStore, setSettingsField } from '../store.ts';
import { bindAppearanceAppliers } from '../apply.ts';
import * as runtimeSwitch from '../../runtime-switch.ts';
const mock = vi.mocked(runtimeFetch);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let disconnect: (() => void) | undefined;
let saved: Record<string, unknown>, revision: number;
beforeEach(() => {
  vi.useFakeTimers(); saved = { fontSize: 100, inputSpellcheckEnabled: true }; revision = 0;
  mock.mockReset(); mock.mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); expect(body.expected_revision).toBe(revision); saved = { ...saved, ...body.settings }; revision += 1; }
    return response({ revision, settings: saved });
  });
});
afterEach(() => { disconnect?.(); disconnect = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); useSettingsStore.setState({ doc: {}, loading: true }); });
const tick = async () => { await vi.advanceTimersByTimeAsync(250); };
it('applies edits through the real store, persists only changed fields, and restores after reconnect', async () => {
  const offApply = bindAppearanceAppliers(); disconnect = connectNativePreferences(); await tick();
  setSettingsField('fontSize', 125); setSettingsField('inputSpellcheckEnabled', false);
  expect(document.documentElement.style.fontSize).toBe('125%'); await tick();
  expect(mock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init!.body)))).toEqual([{ expected_revision: 0, settings: { fontSize: 125, inputSpellcheckEnabled: false } }]);
  expect(useNativePreferenceState.getState().status).toBe('saved');
  disconnect(); disconnect = connectNativePreferences(); await tick();
  expect(useSettingsStore.getState().doc).toEqual({ fontSize: 125, inputSpellcheckEnabled: false }); offApply();
});
it.each([409, 503])('preserves unsaved edits on HTTP %i and allows explicit recovery', async status => {
  disconnect = connectNativePreferences(); await tick();
  mock.mockResolvedValueOnce(response({}, status)); setSettingsField('fontSize', 150); await tick();
  expect(useNativePreferenceState.getState().status).toBe(status === 409 ? 'conflict' : 'error');
  expect(useSettingsStore.getState().doc.fontSize).toBe(150);
  if (status === 409) { await retryNativePreferences(); expect(revision).toBe(0); await reloadNativePreferences(); expect(useSettingsStore.getState().doc.fontSize).toBe(100); }
  else { await retryNativePreferences(); expect(saved.fontSize).toBe(150); }
});
it('rejects false success when the server does not return the applied value', async () => {
  disconnect = connectNativePreferences(); await tick();
  mock.mockResolvedValueOnce(response({ revision: 1, settings: { fontSize: 100 } }));
  setSettingsField('fontSize', 150); await tick();
  expect(useNativePreferenceState.getState().status).toBe('error'); expect(useSettingsStore.getState().doc.fontSize).toBe(150);
});
it('retains newer edits during a pending write and serializes the next revision', async () => {
  disconnect = connectNativePreferences(); await tick();
  let resolve!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  setSettingsField('fontSize', 125); await tick(); setSettingsField('fontSize', 150);
  revision = 1; saved.fontSize = 125; resolve(response({ revision, settings: { ...saved } })); await tick();
  expect(saved.fontSize).toBe(150); expect(revision).toBe(2); expect(useNativePreferenceState.getState().status).toBe('saved');
});
it('ignores late reads from a retired runtime', async () => {
  let resolve!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const old = connectNativePreferences(); old(); disconnect = connectNativePreferences(); await tick();
  resolve(response({ revision: 99, settings: { fontSize: 190 } })); await tick();
  expect(useSettingsStore.getState().doc.fontSize).toBe(100); setSettingsField('fontSize', 125); await tick(); expect(revision).toBe(1);
});
it('retries a failed initial read and never writes settings before a valid revision', async () => {
  mock.mockResolvedValueOnce(response({}, 503)); disconnect = connectNativePreferences(); await tick();
  setSettingsField('fontSize', 150); expect(mock.mock.calls).toHaveLength(1);
  await retryNativePreferences(); expect(useSettingsStore.getState().doc.fontSize).toBe(100); expect(useNativePreferenceState.getState().status).toBe('saved');
});
it('rejects an old reply as soon as connection identity changes, before component cleanup', async () => {
  let resolve!: (response: Response) => void;
  mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  disconnect = connectNativePreferences();
  vi.spyOn(runtimeSwitch, 'getRuntimeKey').mockReturnValue('host:other');
  resolve(response({ revision: 99, settings: { fontSize: 190 } })); await tick();
  expect(useSettingsStore.getState().doc.fontSize).toBeUndefined();
  setSettingsField('fontSize', 125); await tick(); expect(mock.mock.calls).toHaveLength(1);
});
it('bounds an unresponsive preference read and allows recovery', async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
  mock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('Timed out')))));
  disconnect = connectNativePreferences(); expect(timeout).toHaveBeenCalledWith(15000);
  deadline.abort(); await tick();
  expect(useNativePreferenceState.getState().status).toBe('error'); expect(useSettingsStore.getState().loadError).toBe(true);
  await retryNativePreferences(); expect(useNativePreferenceState.getState().status).toBe('saved');
});
