// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';

const runtime = vi.hoisted(() => ({ key: 'native-runtime', listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => runtime.key,
  isTransientRuntimeKey: () => false, onRuntimeEndpointChanged: (listener: () => void) => {
    runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { NativeUpdateState } from '../pages/native-update-state.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const SHA = 'a'.repeat(40);
const identity = { installation_id: 'install_ws', data_id: 'data_ws', scope: 'user' };
const recorded = { ...identity, schema_version: '1.0', state: 'recorded', format: 1,
  checked_at: '2026-10-06T01:02:03.004Z', status: 'ready', latest_version: '20261007-1',
  latest_ref: 'main', latest_tag: null, latest_sha: SHA, error_code: null };
const catalog = { schema_version: '1.0', source: 'update_state', scope: 'user',
  fields: ['format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag',
    'latest_sha', 'error_code'].map((path) => ({ path, classification: 'generated_state',
    application: 'next_update_check', editability: { available: false, scope: 'user',
    reason: 'generated_state' } })) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<NativeUpdateState />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('reads the recorded check, honest absence, and refreshes without writing', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/update-state')) return Promise.resolve(json(recorded));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const text = container.textContent ?? '';
  expect(text).toContain('ready');
  expect(text).toContain('20261007-1');
  expect(container.querySelector('[data-testid="native-update-state-latest"]')?.textContent).toBe('20261007-1');
  expect(text).toContain('NNA updater');
  await click('Refresh');
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/update-state')).length).toBe(2);
  expect(fetchMock.mock.calls.some(([, init]) => init && (init as RequestInit).method
    && (init as RequestInit).method !== 'GET')).toBe(false);
  await act(async () => root.unmount()); container.remove();
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/update-state')) return Promise.resolve(json({ ...identity, schema_version: '1.0',
      state: 'absent' }));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('No update check has been recorded yet.');
});

it('maps errors to honest sentences and pauses for auth and authority', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/update-state')) return Promise.resolve(json(
      { error: { code: 'nnd_update_state_request_invalid' } }, 400));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('could not be read in the expected shape');
  await act(async () => root.unmount()); container.remove();
  fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
  await act(async () => useAuthSessionStore.setState({ status: 'signed-out' } as never));
  await mount();
  expect(container.textContent).toContain('Sign in to read the native update state.');
  useAuthSessionStore.getState().markOk();
  await settle();
  expect(container.querySelector('[data-testid="native-update-state-table"]')).toBeNull();
});
