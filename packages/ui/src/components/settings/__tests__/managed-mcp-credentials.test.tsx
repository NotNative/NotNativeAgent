// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { createHash } from 'node:crypto';

const runtime = vi.hoisted(() => ({ key: 'native-runtime', listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => runtime.key,
  isTransientRuntimeKey: () => false, onRuntimeEndpointChanged: (listener: () => void) => {
    runtime.listeners.add(listener); return () => runtime.listeners.delete(listener); } }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { ManagedMcpCredentialsSettings } from '../pages/managed-mcp-credentials.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const identity = { installation_id: 'install_mcp', data_id: 'data_mcp', scope: 'user' };
const TOKEN = 't'.repeat(32);
// Local mirror of NNA's managedMcpCredentialReference for expected-reference pins.
const referenceFor = (serverId: string) => {
  const stem = serverId.toUpperCase().replace(/[^A-Z0-9]/gu, '_').slice(0, 40).replace(/_+$/u, '');
  const digest = createHash('sha256').update(serverId).digest('hex').slice(0, 12).toUpperCase();
  return `NNA_MCP_MANAGED_${stem}_${digest}_TOKEN`;
};
const list = (entries: { reference: string; applied: boolean }[], absent = false) => ({
  ...identity, source_state: absent ? 'absent' : 'present', count: entries.length,
  credentials: entries, application: 'next_server_spawn' });
const catalog = () => ({ schema_version: '1.0', source: 'managed_mcp_credentials', scope: 'user',
  fields: [{ path: 'credentials.{NNA_MCP_MANAGED_reference}', classification: 'operator_setting',
    type: 'secret', application: 'next_server_spawn', scope: 'user',
    required_permission: 'nnd.configuration.manage',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }] });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement;
let root: Root | undefined;async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => root!.render(<ManagedMcpCredentialsSettings />)); await settle(); }
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
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined; runtime.listeners.clear();
  expect(container?.textContent).not.toContain(TOKEN); });

const stored: { reference: string | null } = { reference: null };
let served = { source_state: 'absent', entries: [] as { reference: string; applied: boolean }[] };
const serveLists = () => {
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/mcp-credentials') && method === 'GET') {
      return Promise.resolve(jsonResponse(list(served.entries, served.source_state === 'absent')));
    }
    if (path.endsWith('/mcp-credentials/catalog')) return Promise.resolve(jsonResponse(catalog()));
    throw new Error('unexpected ' + path + ' ' + method);
  });
};

it('upserts a token, shows the reference and applied flag, and never renders the value', async () => {
  const reference = referenceFor('filesystem-mcp');
  stored.reference = null; served = { source_state: 'absent', entries: [] };
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/mcp-credentials') && method === 'GET') {
      return Promise.resolve(jsonResponse(list(served.entries, served.source_state === 'absent')));
    }
    if (path.endsWith('/mcp-credentials/catalog')) return Promise.resolve(jsonResponse(catalog()));
    if (path.endsWith('/mcp-credentials/credentials/save') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { server_id: string; token: string; operation_id: string };
      expect(body.token).toBe(TOKEN);
      expect(body.operation_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      stored.reference = referenceFor(body.server_id);
      served = { source_state: 'present', entries: [{ reference: stored.reference, applied: true }] };
      return Promise.resolve(jsonResponse({ ...identity, operation_id: body.operation_id,
        persistence: 'saved', reference: stored.reference, application: 'next_server_spawn',
        next_action: 'inspect_native_operation' }));
    }
    throw new Error('unexpected ' + path + ' ' + method);
  });
  await mount();
  const status = () => container.querySelector('[data-testid="mcp-status"]')?.textContent ?? '';
  expect(status()).toContain('store: absent');
  expect(status()).toContain('references: 0');
  await type('[data-testid="mcp-server"]', 'filesystem-mcp');
  await type('[data-testid="mcp-token"]', TOKEN);
  await click('Stage the credential');
  expect(container.querySelector('[data-testid="mcp-stage-content"]')?.textContent)
    .toContain('reference derived from it');
  await click('Save credential');
  const refreshed = () => container.querySelector('[data-testid="mcp-list"]')?.textContent ?? '';
  expect(refreshed()).toContain(stored.reference!);
  expect(refreshed()).toContain('applied');
  expect(container.textContent).toContain("Operation ");
  expect(container.textContent).not.toContain(TOKEN);
  // Delete the stored credential: the honest path reports the receipt and empties the roster.
  await click('Delete');
  expect(container.querySelector('[data-testid="mcp-stage-delete"]')?.textContent)
    .toContain('delete of ' + stored.reference);
  fetchMock.mockImplementationOnce((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/mcp-credentials/credentials/delete') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { reference: string; operation_id: string };
      expect(body.reference).toBe(reference);
      stored.reference = null; served = { source_state: 'absent', entries: [] };
      return Promise.resolve(jsonResponse({ ...identity, operation_id: body.operation_id,
        persistence: 'deleted', reference: body.reference, application: 'next_server_spawn',
        next_action: 'inspect_native_operation' }));
    }
    throw new Error('unexpected ' + path + ' ' + method);
  });
  await click('Delete credential');
  expect(container.querySelector('[data-testid="mcp-status"]')?.textContent).toContain('store: absent');
});

it('surfaces the token grammar and store-refusals as honest sentences', async () => {
  stored.reference = null; served = { source_state: 'absent', entries: [] };
  serveLists();
  await mount();
  // Single-line inputs strip line breaks before staging (browser behavior), so the
  // grammar refusal that reaches the client is the over-long token: 16,385 characters.
  await type('[data-testid="mcp-server"]', 'filesystem-mcp');
  await type('[data-testid="mcp-token"]', 't'.repeat(16_385));
  await click('Stage the credential');
  await click('Save credential');
  expect(container.textContent).toContain('token value is invalid');
  // A corrupt store reads as an honest repair sentence from NNA.
  fetchMock.mockImplementation((path: string) => path.endsWith('/catalog')
    ? Promise.resolve(jsonResponse(catalog()))
    : Promise.resolve(jsonResponse({ error: { code: 'mcp_credentials_invalid' } }, 503)));
  await click('Refresh');
  expect(container.textContent).toContain('needs native repair');
  expect((container.textContent.match(/mcp_credentials_invalid/g) ?? []).length).toBeGreaterThanOrEqual(1);
});
