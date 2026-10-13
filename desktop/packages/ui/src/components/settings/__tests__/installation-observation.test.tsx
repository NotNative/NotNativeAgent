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
import { InstallationObservationPanel } from '../pages/installation-observation.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const view = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', product: 'NotNativeAgent', version: '20261006-16',
  install_root: 'C:\\Program Files\\NotNativeAgent',
  data_root: 'C:\\Users\\operator\\AppData\\Roaming\\NotNativeAgent',
  node: 'C:\\runtime\\node.exe', node_major: 24 });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/installation')) {
      return Promise.resolve(new Response(JSON.stringify(view()), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('projects the verified installation descriptor on the settings page', async () => {
  await mount(() => <InstallationObservationPanel />);
  const rendered = () => container.querySelector('[data-testid="installation-view"]')?.textContent ?? '';
  expect(rendered()).toContain('NotNativeAgent');
  expect(rendered()).toContain('20261006-16');
  expect(rendered()).toContain('node.exe (24)');
  // The two roots are the fields an operator actually acts on when an installation is
  // wrong, and they had never been asserted despite the panel rendering both.
  expect(rendered()).toContain('C:\\Program Files\\NotNativeAgent');
  expect(rendered()).toContain('C:\\Users\\operator\\AppData\\Roaming\\NotNativeAgent');
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/configuration/installation')
    && !String(path).includes('/catalog'))).toBe(true);
});

it('surfaces the descriptor authority verdict when the disk no longer verifies', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (String(path).endsWith('/configuration/installation')) {
      return Promise.resolve(new Response(JSON.stringify({ error: {
        code: 'nnd_install_descriptor_unavailable' } }), { status: 503 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  await mount(() => <InstallationObservationPanel />);
  const alert = () => container.querySelector('[role="alert"]')?.textContent ?? '';
  expect(alert()).toContain('could not be read; repair the installation');
});
