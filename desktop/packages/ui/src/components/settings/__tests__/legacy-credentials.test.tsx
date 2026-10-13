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
import { LegacyCredentialsPanel } from '../pages/legacy-credentials.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const receipt = (loaded: boolean) => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  loaded, count: loaded ? 1 : 0,
  reason: loaded ? null : 'provider_credentials_invalid' });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/legacy-provider-credentials')) {
      return Promise.resolve(new Response(JSON.stringify(receipt(true)), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('renders the loaded verdict without ever revealing the alias value', async () => {
  await mount(() => <LegacyCredentialsPanel />);
  const rendered = () => container.querySelector('[data-testid="legacy-credentials-receipt"]')?.textContent ?? '';
  expect(rendered()).toContain('yes');
  expect(rendered()).toContain('active at startup');
  expect(rendered()).not.toMatch(/sk-/i);
  expect(fetchMock.mock.calls.some(([path]) =>
    String(path).endsWith('/configuration/legacy-provider-credentials'))).toBe(true);
});

it('renders the honest store-refusal sentence when the alias store is malformed', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/legacy-provider-credentials')) {
      return Promise.resolve(new Response(JSON.stringify(receipt(false)), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  await mount(() => <LegacyCredentialsPanel />);
  const rendered = () => container.querySelector('[data-testid="legacy-credentials-receipt"]')?.textContent ?? '';
  expect(rendered()).toContain('unsupported shape');
});
