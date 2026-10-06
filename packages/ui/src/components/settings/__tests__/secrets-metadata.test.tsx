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
import { SecretsMetadataSettings } from '../pages/secrets-metadata.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const identity = { installation_id: 'install_secrets', data_id: 'data_secrets', scope: 'user' };
const record = () => ({ id: 'sec_00000000-0000-4000-8000-000000000000', realm: 'nna.local',
  label: 'Registry credential', kind: 'api_key', scope: { kind: 'workspace', id: 'io' },
  metadata: { team: ['core', 'fringe'], region: 'eu-1' }, fields: ['apikey'], enabled: true,
  created_at: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06T00:00:00.000Z',
  rotated_at: null, last_used_at: null, use_count: 0 });
const catalog = () => ({ schema_version: '1.0', source: 'secrets', scope: 'user',
  fields: ['label', 'kind', 'scope', 'metadata.{name}', 'fields.{field}', 'enabled'].map(path => ({
    path, classification: 'operator_setting', application: 'next_secret_use', scope: 'user',
    required_permission: 'nnd.configuration.read',
    editability: { available: false, scope: 'user', reason: 'secret_broker_actions' } })) });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement;
let root: Root | undefined;async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => root!.render(<SecretsMetadataSettings />)); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined; runtime.listeners.clear(); });

it('renders the roster honestly: absent vault, present records, vault damage sentences', async () => {
  fetchMock.mockImplementation((path: string) => path.endsWith('/configuration/secrets/catalog')
    ? Promise.resolve(jsonResponse(catalog()))
    : Promise.resolve(jsonResponse({ ...identity, source_state: 'absent', count: 0, secrets: [],
      application: 'next_secret_use' })));
  await mount();
  const status = () => container.querySelector('[data-testid="secrets-status"]')?.textContent ?? '';
  expect(status()).toContain('vault: absent');
  expect(status()).toContain('records: 0');
  // A real roster renders redaction-safe lines only: label · kind · enabled · field count.
  fetchMock.mockImplementation((path: string) => path.endsWith('/configuration/secrets/catalog')
    ? Promise.resolve(jsonResponse(catalog()))
    : Promise.resolve(jsonResponse({ ...identity, source_state: 'present', count: 1,
      secrets: [record()], application: 'next_secret_use' })));
  const refresh = [...container.querySelectorAll('button')].find(b => b.textContent === 'Refresh')!;
  await act(async () => refresh.click()); await settle();
  expect(status()).toContain('records: 1');
  expect(container.querySelector('[data-testid="secrets-list"]')?.textContent)
    .toContain('Registry credential · api_key · enabled · fields 1 · scope workspace:io');
  expect(JSON.stringify(fetchMock.mock.calls.map(call => call[1]?.body))).not.toContain('apikey:');
  // Vault damage shows the honest repair sentence instead of an empty roster.
  fetchMock.mockImplementation((path: string) => path.endsWith('/configuration/secrets/catalog')
    ? Promise.resolve(jsonResponse(catalog()))
    : Promise.resolve(jsonResponse({ error: { code: 'secret_vault_corrupt' } }, 503)));
  await act(async () => refresh.click()); await settle();
  expect(container.textContent).toContain('needs native repair');
  expect((container.textContent.match(/secret_vault_corrupt/g) ?? []).length).toBeGreaterThanOrEqual(1);
  // The surface never mutates: only GETs and the catalog have been called.
  const methods = fetchMock.mock.calls.map(call => (call[1] as RequestInit | undefined)?.method ?? 'GET');
  expect(methods.every(method => method === 'GET')).toBe(true);
});
