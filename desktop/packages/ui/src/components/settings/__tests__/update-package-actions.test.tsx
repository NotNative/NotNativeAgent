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
import { UpdateActionsPanel } from '../pages/update-actions.tsx';
import { PackageActionsPanel } from '../pages/package-actions.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const OP = '550e8400-e29b-41d4-a716-446655440000';
const STAMP = '2026-10-06T18:00:00.000Z';
const checkReceipt = () => ({ schema_version: '1.0', installation_id: 'install_updates',
  data_id: 'data_updates', scope: 'user', action: 'check', application: 'update_check_recorded',
  operation_id: OP, availability: { status: 'ready', checked_at: STAMP, cached: false,
    current_version: '20261006-3', latest_version: '20261006-9', latest_ref: 'main',
    latest_tag: null, latest_sha: 'a'.repeat(40), available: true, error_code: null } });
const packageReceipt = (registered = true) => ({ schema_version: '1.0',
  installation_id: 'install_updates', data_id: 'data_updates', scope: 'user',
  action: registered ? 'status' : 'status', application: 'not_applied', operation_id: null,
  package: registered ? { registered: true, valid: true, root: 'D:/apps/desktop',
    version: '20261006-3' } : { registered: false } });
let container: HTMLDivElement;
let root: Root | undefined;
const requests: [string, string | undefined][] = [];
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
function valueSetter() { return Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set; }
async function typeIn(placeholder: string, text: string) {
  const item = inputOf(placeholder); await act(async () => {
    valueSetter()?.call(item, text);
    item.dispatchEvent(new window.Event('input', { bubbles: true })); }); await settle(); }
async function click(label: string) { const target = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!target) throw new Error('missing ' + label); await act(async () => target.click()); await settle(); }
function inputOf(placeholder: string): HTMLInputElement {
  const item = [...container.querySelectorAll('input')]
    .find(entry => (entry as HTMLInputElement).placeholder === placeholder) as HTMLInputElement;
  if (!item) throw new Error('missing ' + placeholder);
  return item;
}
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); requests.length = 0; sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    requests.push([path, init?.method]);
    if (String(path).endsWith('/update/actions/check')) {
      return Promise.resolve(new Response(JSON.stringify(checkReceipt()), { status: 200 }));
    }
    if (String(path).endsWith('/update/actions/install')) {
      return Promise.resolve(new Response(JSON.stringify({ error: { code: 'nnd_update_install_unsupported',
        message: 'the product installer runs through the local CLI' } }), { status: 400 }));
    }
    if (String(path).endsWith('/nnd-package/actions/activate')) {
      return Promise.resolve(new Response(JSON.stringify({ schema_version: '1.0',
        installation_id: 'install_updates', data_id: 'data_updates', scope: 'user',
        action: 'activate', application: 'registered_root', operation_id: OP,
        package: { registered: true, valid: true, root: 'D:/apps/desktop',
          version: '20261006-3' } }), { status: 200 }));
    }
    if (String(path).endsWith('/nnd-package/actions/deactivate')) {
      return Promise.resolve(new Response(JSON.stringify({ schema_version: '1.0',
        installation_id: 'install_updates', data_id: 'data_updates', scope: 'user',
        action: 'deactivate', application: 'unregistered_root', operation_id: OP,
        package: { registered: false } }), { status: 200 }));
    }
    if (String(path).endsWith('/nnd-package')) {
      return Promise.resolve(new Response(JSON.stringify(packageReceipt()), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('runs the native update check only on click and exposes terminal installation guidance', async () => {
  await mount(() => <UpdateActionsPanel />);
  expect(requests).toHaveLength(0);
  await click('Check now');
  const view = () => container.querySelector('[data-testid="update-check-view"]')?.textContent ?? '';
  const call = requests.find(([path]) => String(path).endsWith('/update/actions/check'));
  expect(call?.[1]).toBe('POST');
  expect(view()).toContain('Current version20261006-3'); expect(view()).toContain('Latest version20261006-9');
  expect(container.querySelector('[data-testid="update-install"]')).toBeNull();
  expect(container.textContent).toContain('nna update'); expect(requests).toHaveLength(1);
});

it('registers and unregisters the package root through the runtime registry', async () => {
  await mount(() => <PackageActionsPanel />);
  const view = () => container.querySelector('[data-testid="package-view"]')?.textContent ?? '';
  expect(view()).toContain('registered root D:/apps/desktop · version 20261006-3 · valid');
  await typeIn('absolute package root', 'D:/apps/desktop');
  await click('Activate…');
  expect(requests.find(([path, method]) => method === 'POST'
    && String(path).endsWith('/nnd-package/actions/activate'))).toBeTruthy();
  const receipt = () => container.querySelector('[data-testid="package-receipt"]')?.textContent ?? '';
  expect(receipt()).toContain('activated D:/apps/desktop');
  await click('Deactivate…');
  expect(requests.find(([path, method]) => method === 'POST'
    && String(path).endsWith('/nnd-package/actions/deactivate'))).toBeTruthy();
  expect(receipt()).toContain('deactivated D:/apps/desktop');
  // The unregistered reading exists in the fixture but had never been exercised.
  // An operator with nothing registered must be told so, not handed an empty panel.
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    requests.push([path, init?.method]);
    const body = String(path).endsWith('/nnd-package') ? packageReceipt(false) : {};
    const status = String(path).endsWith('/nnd-package') ? 200 : 404;
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });
  await click('Refresh');
  expect(view()).toContain('no NND package is registered natively');
});
