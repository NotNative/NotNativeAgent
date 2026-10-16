// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
const runtime = vi.hoisted(() => ({ key: 'native-runtime', listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', async original => ({ ...(await original<object>()), getRuntimeKey: () => runtime.key,
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { SecretActionsConsole } from '../pages/secret-console.tsx';
import type { PublicSecret } from '../../../lib/nnd/secret-actions.ts';
const ID = 'sec_00000000-0000-4000-8000-000000000000', stamp = '2026-10-06T16:00:00.000Z';
const secret = (): PublicSecret => ({ id: ID, realm: 'nna.local', label: 'Registry credential', kind: 'api_key', fields: ['api_key'],
  scope: { kind: 'workspace', id: 'original-owner' }, metadata: { owner: 'keep' }, enabled: true, createdAt: stamp, updatedAt: stamp, rotatedAt: null, lastUsedAt: null, useCount: 0 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let node: HTMLDivElement, root: Root, records: PublicSecret[], writes: { path: string; method: string; body: any }[];
const fetchMock = runtimeFetch as Mock;
async function server(path: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (method === 'GET') return json(path.endsWith('/scopes') ? { can_manage: true, scopes: [{ kind: 'user', id: 'test-operator' }, { kind: 'workspace', id: 'original-owner' }] }
    : path.includes('/audit') ? { events: [] } : { secrets: records });
  writes.push({ path, method, body });
  if (method === 'DELETE') { records = []; return json({ ok: true }); }
  if (method === 'POST') { const created = { ...secret(), ...body, fields: Object.keys(body.fields).sort(), scope: body.scope, metadata: body.metadata }; records = [created]; return json({ secret: created }, 201); }
  records = records.map(row => ({ ...row, ...(path.endsWith('/values') ? { rotatedAt: stamp } : body) }));
  return json({ secret: records[0] });
}
async function settle() { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); }
async function click(label: string) { const button = [...node.querySelectorAll('button')].find(row => row.textContent === label); expect(button, label).toBeTruthy(); await act(async () => button!.click()); await settle(); }
async function type(label: string, value: string) { const input = node.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function mount() { node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(async () => root.render(<SecretActionsConsole />)); await settle(); }
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk(); records = [secret()]; writes = []; fetchMock.mockReset(); fetchMock.mockImplementation(server); });
afterEach(() => { act(() => root?.unmount()); node?.remove(); runtime.listeners.clear(); });

it('renames a secret without rewriting its existing scope or metadata, and refreshes the actual roster', async () => {
  await mount(); await click('Edit details'); await type('Secret label', 'Renamed'); await click('Save changes');
  expect(writes[0]?.body).toEqual({ label: 'Renamed' });
  expect(records[0]?.scope).toEqual({ kind: 'workspace', id: 'original-owner' }); expect(records[0]?.metadata).toEqual({ owner: 'keep' });
  expect(node.querySelector('[data-testid="secret-row"]')?.textContent).toContain('Renamed');
  expect(node.querySelector('[data-testid="secret-editor"]')).toBeNull(); expect(node.textContent).toContain('Updated Renamed');
});
it('creates a username/password record with both fields and clears values after acknowledgement', async () => {
  await mount(); await click('New secret');
  await act(async () => { const select = node.querySelector<HTMLSelectElement>('[aria-label="Secret kind"]')!; select.value = 'username_password'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await type('Secret label', 'Login test');
  // Browser autofill can dispatch both field changes in one task; neither value may overwrite the other.
  await act(async () => { for (const [name, value] of [['username', 'test-user'], ['password', 'test-password']]) {
    const input = node.querySelector<HTMLInputElement>(`[aria-label="Secret value ${name}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true }));
  } }); await click('Create secret');
  expect(writes[0]?.body.fields).toEqual({ username: 'test-user', password: 'test-password' });
  expect(node.querySelector('[data-testid="secret-row"]')?.textContent).toContain('Login test');
  expect(node.textContent).not.toContain('test-password'); expect(node.querySelector('input[type="password"]')).toBeNull();
});
it('requires review before status changes or deletion and refreshes the resulting rows', async () => {
  await mount(); await click('Disable'); expect(writes).toHaveLength(0); await click('Cancel operation'); expect(writes).toHaveLength(0);
  await click('Disable'); await click('Confirm disable'); expect(node.querySelector('[data-testid="secret-row"]')?.textContent).toContain('Disabled');
  await click('Enable'); await click('Confirm enable'); expect(node.querySelector('[data-testid="secret-row"]')?.textContent).toContain('Enabled');
  await click('Delete'); expect(writes.filter(row => row.method === 'DELETE')).toHaveLength(0); await click('Confirm delete');
  expect(node.querySelectorAll('[data-testid="secret-row"]')).toHaveLength(0); expect(node.textContent).toContain('Deleted Registry credential');
});
it('rotates only the selected values and never requests the secret-use endpoint', async () => {
  await mount(); await click('Rotate values'); await type('Secret value api_key', 'rotated-test-value'); await click('Rotate secret');
  expect(writes[0]).toEqual({ path: `/api/v1/secrets/${ID}/values`, method: 'PUT', body: { fields: { api_key: 'rotated-test-value' } } });
  expect(node.querySelector('input[type="password"]')).toBeNull(); expect(node.textContent).not.toContain('rotated-test-value');
  expect(fetchMock.mock.calls.every(([path]) => !String(path).endsWith('/use'))).toBe(true);
});
it.each(['label', 'identity'])('refuses false success when the broker acknowledges the wrong %s', async mismatch => {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => init?.method === 'PATCH' ? Promise.resolve(json({ secret: mismatch === 'label' ? secret()
    : { ...secret(), label: 'Expected label', id: 'sec_00000000-0000-4000-8000-000000000001' } })) : server(path, init));
  await mount(); await click('Edit details'); await type('Secret label', 'Expected label'); await click('Save changes');
  expect(node.querySelector('[data-testid="secret-receipt"]')).toBeNull(); expect(node.querySelector<HTMLInputElement>('[aria-label="Secret label"]')?.value).toBe('Expected label');
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('did not confirm');
});
it('leaves a bound secret intact and explains a native deletion refusal', async () => {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => init?.method === 'DELETE'
    ? Promise.resolve(json({ error: { code: 'secret_in_use' } }, 409)) : server(path, init));
  await mount(); await click('Delete'); await click('Confirm delete');
  expect(node.querySelector('[data-testid="secret-receipt"]')).toBeNull(); expect(node.querySelectorAll('[data-testid="secret-row"]')).toHaveLength(1);
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('remove those bindings before deleting');
});
it('keeps an acknowledged write distinct from a failed subsequent refresh and supports read retry', async () => {
  let fail = false; fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') { const result = await server(path, init); fail = true; return result; }
    if (fail) return json({ error: { code: 'secret_broker_unavailable' } }, 503); return server(path, init);
  });
  await mount(); await click('Edit details'); await type('Secret label', 'Saved label'); await click('Save changes');
  expect(node.querySelector('[data-testid="secret-receipt"]')?.textContent).toContain('Updated Saved label'); expect(node.querySelector('[role="alert"]')).not.toBeNull();
  fail = false; await click('Refresh'); expect(node.querySelector('[data-testid="secret-row"]')?.textContent).toContain('Saved label');
});
it('does not publish late UI success into another runtime and clears write-only input when authentication expires', async () => {
  let finish!: (result: Response) => void;
  fetchMock.mockImplementation((path: string, init?: RequestInit) => init?.method === 'PATCH' ? new Promise<Response>(resolve => { finish = resolve; }) : server(path, init));
  await mount(); await click('Edit details'); await type('Secret label', 'Host A label'); await click('Save changes');
  await act(async () => { runtime.key = 'host-b'; records = [{ ...secret(), label: 'Host B' }]; for (const listener of [...runtime.listeners]) listener(); }); await settle();
  await act(async () => finish(json({ secret: { ...secret(), label: 'Host A label' } }))); await settle();
  expect(node.textContent).not.toContain('Updated Host A'); expect(node.querySelector('[data-testid="secret-row"]')?.textContent).toContain('Host B');
  await click('New secret'); await type('Secret value api_key', 'temporary-test-value');
  await act(async () => useAuthSessionStore.setState({ status: 'expired' })); expect(node.querySelector('input[type="password"]')).toBeNull();
});
it('offers only native scopes and keeps management controls inert for a read-only principal', async () => {
  await mount(); await click('New secret');
  const picker = node.querySelector<HTMLSelectElement>('[aria-label="Secret scope"]')!;
  expect([...picker.options].map(option => option.value)).toEqual(['user:test-operator', 'workspace:original-owner']);
  expect(picker.value).toBe('user:test-operator'); expect(node.querySelector('[aria-label="Secret scope ID"]')).toBeNull();
  await click('Cancel editor');
  fetchMock.mockImplementation((path: string, init?: RequestInit) => path.endsWith('/scopes')
    ? Promise.resolve(json({ can_manage: false, scopes: [{ kind: 'user', id: 'test-operator' }] }))
    : path.includes('/audit') ? Promise.resolve(json({ error: { code: 'integration_permission_denied' } }, 403)) : server(path, init));
  await click('Refresh'); expect([...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'New secret')?.disabled).toBe(true);
  expect([...node.querySelectorAll<HTMLButtonElement>('[data-testid="secret-row"] button')].every(button => button.disabled)).toBe(true);
  expect(node.querySelector('[role="alert"]')).toBeNull(); expect(node.textContent).toContain('Audit access is unavailable');
  expect(writes).toHaveLength(0);
});
