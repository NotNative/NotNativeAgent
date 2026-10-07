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
  version: 1, enabled: true, token_present: false, token_env: 'NNA_TELEGRAM_BOT_TOKEN', authorized_user_ids: ['123'],
  workspace_root: null, polling_timeout_seconds: 25, updated_at: null, application: 'not_applied' };
const field = (path: string, extra: Record<string, unknown> = {}) => ({ path, application: 'restart_gateway',
  ...extra, editability: extra.editability ?? { available: true, scope: 'user',
    required_permission: 'nnd.configuration.manage' } });
const catalog = { schema_version: '1.0', source: 'gateway', scope: 'user', fields: [
  field('version', { classification: 'generated_state', editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  field('updated_at', { classification: 'generated_state', editability: { available: false, scope: 'user', reason: 'generated_state' } }),
  field('enabled', { classification: 'operator_setting' }),
  field('token', { classification: 'operator_setting', sensitivity: 'secret' }),
  field('token_env', { classification: 'operator_setting' }),
  field('authorized_user_ids', { classification: 'authority_grant' }),
  field('workspace_root', { classification: 'operator_setting' }),
  field('polling_timeout_seconds', { classification: 'operator_setting' })] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const token = 'replacement-telegram-token-goes-here';
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<NativeGatewayTimeout />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const saved = (operationId: string) => ({ installation_id: view.installation_id, data_id: view.data_id,
  scope: 'user', operation_id: operationId, persistence: 'saved', before_revision: revision,
  persisted_revision: savedRevision, application: 'not_applied', next_action: 'restart_gateway', replayed: false,
  replay_window: 'last_128_operations' });
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('previews and saves only a bounded polling timeout with exact NNA revision, then says restart required', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json({ ...view, updated_at: '2026-10-07T04:00:00.000Z' }));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) return Promise.resolve(json(saved(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  // The read state shows every field these rows ask about, and the secret never
  // arrives as a value: the token reaches the surface only as its presence, and
  // the replace field starts empty rather than echoing anything.
  expect(container.textContent).toContain('Gateway is enabled');
  expect(container.textContent).toContain('token present: no');
  expect(container.textContent).toContain('saved polling timeout: 25 seconds');
  expect(container.textContent).toContain('authorized users: 123');
  expect(container.textContent).toContain('Authorized numeric user ids');
  expect([...container.querySelectorAll('button')].filter(item => item.textContent === 'Remove')).toHaveLength(1);
  const secretInput = container.querySelector<HTMLInputElement>('[data-testid="gateway-token-value"]')!;
  expect(secretInput.type).toBe('password');
  expect(secretInput.value).toBe('');
  expect(container.querySelector<HTMLInputElement>('[data-testid="gateway-token-env"]')!.value)
    .toBe('NNA_TELEGRAM_BOT_TOKEN');
  expect(container.querySelector<HTMLInputElement>('[data-testid="gateway-workspace-root"]')!.value).toBe('');
  // The stamp the native transaction writes on every save is shown rather than
  // silently dropped, and an absent stamp says so instead of guessing.
  expect(container.textContent).toContain('last saved: 2026-10-07T04:00:00.000Z');
  await type('input[type="number"]', '30');
  await click('Preview native change');
  expect(container.textContent).toContain('polling: 30 seconds');
  expect(container.textContent).toContain('No change has been saved or applied.');
  await click('Save with native revision check');
  expect(container.textContent).toContain('restart the gateway');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body))).toEqual({ installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user', expected_revision: revision,
    expected_resolution_revision: revision, operations: [{ op: 'set', field: 'polling_timeout_seconds', value: 30 }],
    operation_id: expect.any(String) });
  expect(String(saveCall[1].body)).not.toContain('token');
});

it('composes token replacement, user grants, and enablement into one bounded batch', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'not_applied', view: { ...view, token_present: true,
        authorized_user_ids: ['123', '55'], polling_timeout_seconds: 30 } }));
    if (path.endsWith('/save')) return Promise.resolve(json(saved(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('last saved: not recorded');
  await type('input[type="number"]', '30');
  await type('input[type="password"]', token);
  await type('[data-testid="gateway-user-add"]', '55'); // user add field, unique hook
  await click('Add');
  await click('Preview native change');
  expect(container.textContent).toContain('token present: true');
  expect(container.textContent).not.toContain(token);
  await click('Save with native revision check');
  expect(container.textContent).toContain('restart the gateway');
  expect(container.textContent).not.toContain(token);
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  const body = JSON.parse(String(saveCall[1].body));
  expect(body.operations).toContainEqual({ op: 'set_token', token });
  expect(body.operations).toContainEqual({ op: 'authorize', user_id: '55' });
  expect(body.operations).toContainEqual({ op: 'set', field: 'polling_timeout_seconds', value: 30 });
  const previewCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/preview'))!;
  const previewBody = JSON.parse(String(previewCall[1].body));
  expect(previewBody.operations.filter((item: { op: string }) => item.op === 'set_token'))
    .toEqual([{ op: 'set_token', token }]);
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
  await type('input[type="number"]', '30');
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
  await type('input[type="number"]', '30');
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
  await type('input[type="number"]', '30');
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
  await type('input[type="number"]', '30');
  await click('Preview native change'); await click('Save with native revision check');
  await click('Inspect operation');
  expect(container.textContent).toContain('Clear expired local handle');
  await click('Clear expired local handle');
  expect(sessionStorage.getItem('nnd.gateway.timeout.pending.v1')).toBe('[]');
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')).toBeNull();
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('input[type="number"]')).not.toBeNull();
});

it('composes the enable flip, the token variable set and reset, and a revocation', async () => {
  // These three compositions live in the page's composeOperations and were
  // previously only asserted by reading it. Each is now clicked, so the row in
  // the settings census can name an assertion instead of a source line.
  const cases: Array<{ name: string; served: Record<string, unknown>; act: () => Promise<void>;
    expected: Record<string, unknown>; candidate: Record<string, unknown> }> = [
    {
      name: 'flipping the enabled checkbox composes a boolean set',
      served: {},
      act: async () => { await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); },
      expected: { op: 'set', field: 'enabled', value: false },
      candidate: { enabled: false },
    },
    {
      name: 'naming another environment variable composes a set of token_env',
      served: {},
      act: async () => { await type('[data-testid="gateway-token-env"]', 'NNA_GATEWAY_TOKEN'); },
      expected: { op: 'set', field: 'token_env', value: 'NNA_GATEWAY_TOKEN' },
      candidate: { token_env: 'NNA_GATEWAY_TOKEN' },
    },
    {
      name: 'clearing the variable back to blank composes a reset, not an empty value',
      served: { token_env: 'NNA_GATEWAY_TOKEN' },
      act: async () => { await type('[data-testid="gateway-token-env"]', ''); },
      expected: { op: 'reset', field: 'token_env' },
      candidate: { token_env: 'NNA_TELEGRAM_BOT_TOKEN' },
    },
    {
      name: 'removing a grant composes a revocation for that id',
      served: {},
      act: async () => { await click('Remove'); },
      expected: { op: 'revoke', user_id: '123' },
      candidate: { authorized_user_ids: [] },
    },
  ];
  for (const item of cases) {
    fetchMock.mockReset();
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      if (path.endsWith('/gateway')) return Promise.resolve(json({ ...view, ...item.served }));
      if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
      if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
        resolution_revision: revision, application: 'not_applied',
        view: { ...view, ...item.served, ...item.candidate } }));
      if (path.endsWith('/save')) return Promise.resolve(json(saved(JSON.parse(String(init.body)).operation_id)));
      throw new Error('unexpected ' + path);
    });
    await mount();
    await item.act();
    await click('Preview native change');
    await click('Save with native revision check');
    const body = JSON.parse(String(fetchMock.mock.calls.find(([path]) =>
      String(path).endsWith('/save'))![1].body));
    expect(body.operations).toEqual([item.expected]);
    await act(async () => root.unmount()); container.remove();
  }
});

it('refuses to preview when the composed batch carries an invalid user grant', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/gateway')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) throw new Error('preview must not be called for hostile drafts');
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="gateway-user-add"]', 'abc');
  const add = [...container.querySelectorAll('button')].find(item => item.textContent === 'Add');
  expect(add?.disabled).toBe(true);
  await type('[data-testid="gateway-user-add"]', '7');
  await click('Add');
  await type('[data-testid="gateway-workspace-root"]', 'workspace/relative');
  await click('Preview native change');
  expect(container.textContent).toContain('outside the bounded settings grammar');
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/preview'))).toBe(false);
});
