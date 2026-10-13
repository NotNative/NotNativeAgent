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
import { ProviderObservationPanel } from '../pages/provider-observation.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const BASE_PATH = '/configuration/provider-observations';
const secretProvider = { id: 'remote', model: 'remote-model', endpoint: 'https://models.example.test/v1',
  trust_zone: 'public_network',
  credential: { source: 'secret', secret_id: 'sec_provider', field: 'api_key' },
  credential_env: null,
  capabilities: { streaming: true, tools: true, images: false, structured_output: false, usage: true,
    cancellation: false } };
const environmentProvider = { id: 'local', model: 'local-model', endpoint: 'http://127.0.0.1:1234/v1',
  trust_zone: 'loopback', credential: { source: 'environment', name: 'LOCAL_PROVIDER_TOKEN' },
  credential_env: 'LOCAL_PROVIDER_TOKEN',
  capabilities: { streaming: true, tools: false, images: true, structured_output: true, usage: false,
    cancellation: true } };
const view = (providers: unknown[] = [secretProvider, environmentProvider]) => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  source_state: providers.length ? 'present' : 'absent',
  manifest_revision: providers.length ? 'a'.repeat(64) : 'absent', providers });

let container: HTMLDivElement;
let root: Root | undefined;
async function settle() {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
async function mount(panel: () => React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle();
}
function serve(body: unknown, status = 200) {
  fetchMock.mockImplementation((path: string) => Promise.resolve(
    new Response(JSON.stringify(body), { status: String(path).includes(BASE_PATH) ? status : 404 })));
}
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); serve(view()); });
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

const rendered = () => container.querySelector('[data-testid="provider-bindings"]')?.textContent ?? '';

it('renders each provider binding as a reference and never a credential value', async () => {
  await mount(() => <ProviderObservationPanel />);
  expect(rendered()).toContain('remote');
  expect(rendered()).toContain('remote-model');
  expect(rendered()).toContain('https://models.example.test/v1');
  expect(rendered()).toContain('public_network');
  // The thirteen manifest_provider rows are about the binding, so these are the
  // parts a reader acts on: which source, which secret id, which field.
  expect(rendered()).toContain('secret sec_provider field api_key');
  expect(rendered()).toContain('credential_env unset');
  expect(rendered()).toContain('streaming yes, tools yes, images no, structured output no, usage yes, cancellation no');
});

it('renders the environment binding beside its compatibility alias', async () => {
  await mount(() => <ProviderObservationPanel />);
  expect(rendered()).toContain('environment variable LOCAL_PROVIDER_TOKEN');
  expect(rendered()).toContain('credential_env LOCAL_PROVIDER_TOKEN');
  expect(rendered()).toContain('structured output yes');
});

it('says the manifest is absent instead of showing an empty provider list', async () => {
  serve(view([]));
  await mount(() => <ProviderObservationPanel />);
  expect(container.querySelector('[data-testid="provider-bindings"]')).toBeNull();
  expect(container.querySelector('[data-testid="provider-manifest-absent"]')?.textContent)
    .toContain('No provider manifest is stored');
});

it('surfaces the resolver verdict when a provider declares a zone its endpoint contradicts', async () => {
  serve({ error: { code: 'invalid_trust_zone' } }, 400);
  await mount(() => <ProviderObservationPanel />);
  expect(container.querySelector('[role="alert"]')?.textContent)
    .toContain('trust zone that does not match its endpoint');
});

it('surfaces the permission refusal without inventing an empty view', async () => {
  serve({ error: { code: 'integration_permission_denied' } }, 403);
  await mount(() => <ProviderObservationPanel />);
  expect(container.querySelector('[role="alert"]')?.textContent)
    .toContain('lacks the read right for provider configuration');
  expect(container.querySelector('[data-testid="provider-bindings"]')).toBeNull();
});

it('refuses a response that carries a credential value instead of rendering it', async () => {
  serve({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
    source_state: 'present', manifest_revision: 'a'.repeat(64), providers: [{ ...secretProvider,
      credential: { source: 'secret', secret_id: 'sec_provider', field: 'api_key', value: 'sk-secret' } }] });
  await mount(() => <ProviderObservationPanel />);
  expect(container.textContent).not.toContain('sk-secret');
  expect(container.querySelector('[role="alert"]')?.textContent)
    .toContain('drifted from its verified grammar');
});
