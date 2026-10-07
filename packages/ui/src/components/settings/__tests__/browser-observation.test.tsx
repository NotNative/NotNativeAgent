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
import { BrowserObservationPanel } from '../pages/browser-observation.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const receipt = (action: 'status' | 'verify', available: boolean) => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  action, application: 'not_applied', operation_id: 'op_' + 'a'.repeat(20),
  status: available ? { available: true, version: '1.61.1', browser: 'chromium',
    browser_path: 'C:\\nna\\managed\\playwright\\browsers\\chromium.exe',
    root: 'C:\\nna\\managed\\playwright', reason: null }
    : { available: false, version: null, browser: 'chromium', browser_path: null,
      root: 'C:\\nna\\managed\\playwright', reason: 'not_installed' } });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string, init?: { method?: string }) => {
    if (String(path).endsWith('/configuration/browser')
      && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(new Response(JSON.stringify(receipt('status', true)), { status: 200 }));
    }
    if (String(path).endsWith('/configuration/browser/actions/verify')) {
      return Promise.resolve(new Response(JSON.stringify(receipt('verify', true)), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('reads the managed-browser status on mount and re-verifies with the launch probe on demand', async () => {
  await mount(() => <BrowserObservationPanel />);
  const rendered = () => container.querySelector('[data-testid="browser-receipt"]')?.textContent ?? '';
  expect(rendered()).toContain('status');
  expect(rendered()).toContain('1.61.1');
  expect(rendered()).toContain('chromium.exe');
  const verify = container.querySelector('[data-testid="browser-verify"]') as HTMLButtonElement;
  expect(verify).toBeTruthy();
  await act(async () => { verify.click(); }); await settle();
  expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/configuration/browser/actions/verify')
    && (init as { method?: string } | undefined)?.method === 'POST')).toBe(true);
  const after = container.querySelector('[data-testid="browser-receipt"]')?.textContent ?? '';
  expect(after).toContain('verify');
});

it('renders the honest refusal sentence when the managed runtime is missing', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/browser')) {
      return Promise.resolve(new Response(JSON.stringify(receipt('status', false)), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  await mount(() => <BrowserObservationPanel />);
  const rendered = () => container.querySelector('[data-testid="browser-receipt"]')?.textContent ?? '';
  expect(rendered()).toContain('no');
  expect(rendered()).toContain('rerun the NNA installer');
});
