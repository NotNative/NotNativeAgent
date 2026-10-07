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
import { TrustWorkspaces } from '../pages/trust-workspaces.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const canonical = 'C:\\trust\\canonical';
const identity = { installation_id: 'install_ws', data_id: 'data_ws', scope: 'user' };
const list = () => ({ ...identity, schema_version: '1.0', version: 1, source: 'trust',
  application: 'project_configuration',
  fields: ['version', 'workspaces[*].root', 'workspaces[*].trustedAt'],
  workspaces: [{ root: canonical, trusted_at: '2026-10-06T01:02:03.004Z' }] });
const catalog = { schema_version: '1.0', source: 'trust', scope: 'user',
  fields: [
    { path: 'version', classification: 'generated_state', application: 'project_configuration',
      editability: { available: false, scope: 'user', reason: 'generated_state' } },
    { path: 'workspaces[*].root', classification: 'authority_grant',
      application: 'project_configuration', operations: ['grant', 'revoke'],
      required_permission: 'nnd.workspace.manage',
      editability: { available: true, scope: 'user', required_permission: 'nnd.workspace.manage' } },
    { path: 'workspaces[*].trustedAt', classification: 'generated_state',
      application: 'project_configuration',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }] };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<TrustWorkspaces />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
}
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('lists trusted roots, grants through the native surface, and renders canonical receipts', async () => {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path.endsWith('/trust') && (init?.method ?? 'GET') === 'GET') return Promise.resolve(jsonResponse(list()));
    if (path.endsWith('/catalog')) return Promise.resolve(jsonResponse(catalog));
    if (path.endsWith('/trust/grant') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ...identity, schema_version: '1.0', operation: 'grant',
        root: canonical, trusted: true, application: 'project_configuration' }));
    }
    if (path.endsWith('/trust/revoke') && init?.method === 'POST') {
      return Promise.resolve(jsonResponse({ ...identity, schema_version: '1.0', operation: 'revoke',
        root: canonical, trusted: false, application: 'project_configuration' }));
    }
    throw new Error('unexpected ' + path);
  });
  await mount();
  const text = container.textContent ?? '';
  expect(text).toContain('project configuration and skills');
  expect(container.querySelectorAll('[data-testid="trust-row-root"]')[0]?.textContent).toBe(canonical);
  // The stamp the grant wrote and the control that can take the grant back are
  // part of the row, not decoration: assert them rather than trusting the list.
  expect(container.querySelectorAll('[data-testid="trust-row"]')[0]?.textContent)
    .toContain('trusted 2026-10-06T01:02:03.004Z');
  expect(container.querySelectorAll('[data-testid="trust-revoke"]')).toHaveLength(1);
  const draft = container.querySelector('[data-testid="trust-draft"]') as HTMLInputElement;
  expect(draft).not.toBeNull();
  await type('[data-testid="trust-draft"]', 'D:\\proj');
  await click('Grant');
  const text2 = container.textContent ?? '';
  expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/trust/grant')
    && (init as RequestInit | undefined)?.method === 'POST')).toBe(true);
  expect(container.querySelector('[data-testid="trust-receipt-root"]')?.textContent).toBe(canonical);
  expect(text2).toContain('Granted');
  await click('Revoke');
  expect(fetchMock.mock.calls.some(([path, init]) => String(path).endsWith('/trust/revoke'))).toBe(true);
  expect(container.textContent).toContain('Revoked');
  await act(async () => root.unmount()); container.remove();
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/trust')) return Promise.resolve(jsonResponse({ ...list(), workspaces: [] }));
    if (path.endsWith('/catalog')) return Promise.resolve(jsonResponse(catalog));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('No trusted workspaces recorded.');
});

it('surfaces honest store refusals, missing targets, and auth pauses without lying about trust', async () => {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path.endsWith('/trust') && (init?.method ?? 'GET') === 'GET') {
      return Promise.resolve(jsonResponse({ error: { code: 'workspace_trust_invalid' } }, 503));
    }
    if (path.endsWith('/catalog')) return Promise.resolve(jsonResponse(catalog));
    if (path.endsWith('/trust/grant')) {
      return Promise.resolve(jsonResponse({ error: { code: 'workspace_trust_target_missing' } }, 404));
    }
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('unreadable');
  await type('[data-testid="trust-draft"]', 'D:\\gone');
  await click('Grant');
  expect(container.textContent).toContain('does not exist');
  await act(async () => root.unmount()); container.remove();
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/trust')) return Promise.resolve(jsonResponse(list()));
    if (path.endsWith('/catalog')) return Promise.resolve(jsonResponse(catalog));
    throw new Error('unexpected ' + path);
  });
  await act(async () => useAuthSessionStore.setState({ status: 'signed-out' } as never));
  await mount();
  expect(container.textContent).toContain('Sign in to read and change workspace trust.');
  const readsBefore = fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/trust')).length;
  await act(async () => useAuthSessionStore.getState().markOk());
  await settle();
  // The session store flip rebuilds the load callback, so the panel recovers into a
  // fresh read when the session is healthy again.
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/trust')).length).toBe(readsBefore + 1);
  expect(container.querySelector('[data-testid="trust-row-root"]')?.textContent).toBe(canonical);
});
