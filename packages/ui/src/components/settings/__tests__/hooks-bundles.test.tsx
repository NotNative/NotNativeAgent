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
import { HooksBundleSettings } from '../pages/hooks-bundles.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const list = () => ({ schema_version: '1.0', installation_id: 'install_hooks',
  data_id: 'data_hooks', scope: 'user', source_state: 'present', count: 1, application: 'next_hook_use',
  hooks: [{ name: 'a-valid', version: '1.0.0', directory_name: 'a-valid',
    subscriptions: [{ event: 'turn', phase: 'pre', command: 'cmd --flag', blocking: false,
      priority: 5, timeout_ms: 5000, max_concurrent: 2 },
      { event: 'session.start', phase: 'post', command: 'quoted command with spaces', blocking: true,
        priority: 100, timeout_ms: 10_000, max_concurrent: 1 }] }],
  diagnostics: [{ bundle: null, status: 'limit_reached', code: 'hook_bundle_limit_reached', omitted: 3 },
    { bundle: 'b-broken', status: 'skipped', code: 'invalid_hook_manifest' }] });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => root!.render(<HooksBundleSettings />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined; runtime.listeners.clear(); });

it('renders the discovery honesty verbatim: cap, skips, subscriptions, and absence honesty', async () => {
  const responses: unknown[] = [list()];
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.signal) Object.defineProperty(init.signal, 'aborted', { get: () => false });
    return Promise.resolve(responses.length > 0
      ? new Response(JSON.stringify(responses.shift()), { status: 200 })
      : new Response(JSON.stringify({ schema_version: '1.0', installation_id: 'install_hooks',
        data_id: 'data_hooks', scope: 'user', source_state: 'absent', count: 0, hooks: [],
        diagnostics: [], application: 'next_hook_use' }), { status: 200 }));
  });
  await mount();
  const text = () => container.textContent ?? '';
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/nnd/configuration/hooks');
  const roster = () => container.querySelector('[data-testid="hooks-roster"]')?.textContent ?? '';
  expect(roster()).toContain('discovery cap reached: 3 candidate bundles beyond the first 32 were omitted');
  expect(roster()).toContain('bundle b-broken was skipped natively (invalid_hook_manifest)');
  expect(roster()).toContain('a-valid v1.0.0');
  expect(roster()).toContain('turn:pre');
  expect(roster()).toContain('cmd --flag');
  expect(roster()).toContain('session.start:post');
  expect(roster()).toContain('blocking false');
  // Every census field carries its own value, not just an event line: the
  // tuning fields (priority, timeout, concurrency) are the ones a reader would
  // otherwise have to trust the page on.
  expect(roster()).toContain('priority 5, timeout 5000 ms, max 2 concurrent');
  expect(roster()).toContain('priority 100, timeout 10000 ms, max 1 concurrent');
  expect(roster()).not.toContain('c:\\');
  // Refresh swaps in the honest absence sentence; no mutations are ever attempted.
  await click('Refresh');
  expect(text()).toContain('hooks directory does not exist yet');
  expect(container.querySelectorAll('button').length).toBe(1);
  expect(text()).not.toContain('save');
});
