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
import { NativeGatewayTimeout } from '../pages/native-gateway-timeout.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'a'.repeat(64), savedRevision = 'b'.repeat(64);
const view = { schema_version: '1.0', installation_id: 'install_gateway', data_id: 'data_gateway', scope: 'user',
  source_state: 'present', source_revision: revision, resolution_revision: revision, project_shadowed: false,
  polling_timeout_seconds: 25, application: 'not_applied' };
const catalog = { schema_version: '1.0', source: 'gateway', scope: 'user', fields: [{ path: 'polling_timeout_seconds',
  classification: 'operator_setting', type: 'integer', minimum: 5, maximum: 50, application: 'restart_gateway',
  editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<NativeGatewayTimeout />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
const saved = (operationId: string) => ({ installation_id: view.installation_id, data_id: view.data_id,
  scope: 'user', operation_id: operationId, persistence: 'saved', before_revision: revision,
  persisted_revision: savedRevision, application: 'not_applied', next_action: 'restart_gateway', replayed: false,
  replay_window: 'last_128_operations' });
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('previews and saves only a bounded polling timeout with exact NNA revision, then says restart required', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) return Promise.resolve(json(saved(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Preview native change');
  expect(container.textContent).toContain('25 → 30 seconds');
  await click('Save with native revision check');
  expect(container.textContent).toContain('restart the gateway');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body))).toEqual({ installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user', expected_revision: revision,
    expected_resolution_revision: revision, polling_timeout_seconds: 30,
    operation_id: expect.any(String) });
  expect(String(saveCall[1].body)).not.toContain('token');
});

it('retains an uncertain save for native receipt lookup after reload', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json(saved(operationId)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('uncertain outcome');
  await act(async () => root.unmount()); container.remove();
  await mount(); expect(container.textContent).toContain('uncertain outcome');
  await click('Inspect operation');
  expect(container.textContent).toContain('restart the gateway');
  expect(container.textContent).not.toContain('uncertain outcome');
});

it('releases a terminal unpublished operation so a fresh CAS edit can start', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_failed' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json({ ...saved(operationId),
      persistence: 'unpublished', persisted_revision: null, next_action: 'inspect_native_operation' }));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('uncertain outcome');
  await click('Inspect operation');
  expect(container.textContent).toContain('write was not published');
  expect(container.textContent).not.toContain('uncertain outcome');
  expect(sessionStorage.getItem('nnd.gateway.timeout.pending.v1')).toBe('[]');
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')).not.toBeNull();
});

it('releases a directly returned unpublished receipt without claiming application', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) return Promise.resolve(json({ ...saved(JSON.parse(String(init.body)).operation_id),
      persistence: 'unpublished', persisted_revision: null, next_action: 'inspect_native_operation' }));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('write was not published');
  expect(container.textContent).not.toContain('restart the gateway');
  expect(sessionStorage.getItem('nnd.gateway.timeout.pending.v1')).toBe('[]');
});

it('offers explicit recovery from an expired receipt and requires refresh before another edit', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json({ error: 'operation_not_found' }, 404));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '30');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('Preview native change'); await click('Save with native revision check');
  await click('Inspect operation');
  expect(container.textContent).toContain('Clear expired local handle');
  await click('Clear expired local handle');
  expect(sessionStorage.getItem('nnd.gateway.timeout.pending.v1')).toBe('[]');
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')).toBeNull();
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')).not.toBeNull();
});
