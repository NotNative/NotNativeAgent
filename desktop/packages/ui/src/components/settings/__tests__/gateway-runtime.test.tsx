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
import { GatewayRuntimePanel } from '../pages/gateway-runtime.tsx';
import { SearxngDeploymentPanel } from '../pages/searxng-deployment.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const gatewayStatus = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', family: 'gateway', action: 'status', application: 'not_applied',
  config: { enabled: true, configured: true, token_source: 'NNA_TELEGRAM_BOT_TOKEN',
    authorized_user_ids: ['124'], workspace_root: 'C:\\ws', polling_timeout_seconds: 30 },
  runtime: { running: true, pid: 4242, verified: true } });
const botOk = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', family: 'gateway', action: 'test', application: 'not_applied',
  ok: true, bot: { id: 7, username: 'demo_bot' } });
const searxngStatus = () => ({ schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'user', family: 'searxng', action: 'managed-status', application: 'not_applied',
  status: { endpoint: 'http://127.0.0.1:8888/search', container: 'searxng',
    container_error: null, search: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8888' } } });
let container: HTMLDivElement;
let root: Root | undefined;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount(panel: () => React.ReactNode) { container = document.createElement('div');
  document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(panel() as React.ReactNode); }); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string) => {
    const target = String(path);
    if (target.endsWith('/configuration/gateway/status')) {
      return Promise.resolve(new Response(JSON.stringify(gatewayStatus()), { status: 200 }));
    }
    if (target.endsWith('/configuration/gateway/actions/test')) {
      return Promise.resolve(new Response(JSON.stringify(botOk()), { status: 200 }));
    }
    if (target.endsWith('/configuration/web-search/actions/managed-status')) {
      return Promise.resolve(new Response(JSON.stringify(searxngStatus()), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
});
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('renders the gateway runtime merge and the probe verdict without any token value', async () => {
  await mount(() => <GatewayRuntimePanel />);
  const view = () => container.querySelector('[data-testid="gateway-runtime-receipt"]')?.textContent ?? '';
  expect(view()).toContain('identity verified');
  expect(view()).toContain('NNA_TELEGRAM_BOT_TOKEN');
  const probe = await act(async () => {
    const button = container.querySelector('[data-testid="gateway-test-probe"]') as HTMLButtonElement;
    button.click();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
  const verdict = () => container.querySelector('[data-testid="gateway-test-receipt"]')?.textContent ?? '';
  expect(verdict()).toContain('@demo_bot');
  expect(verdict()).not.toMatch(/123|token=/i);
  expect(fetchMock.mock.calls.some(([path]) =>
    String(path).endsWith('/configuration/gateway/status'))).toBe(true);
});

it('states the CLI-only stance honestly for the runtime prose and mounts the deployment view', async () => {
  await mount(() => <SearxngDeploymentPanel />);
  const view = () => container.querySelector('[data-testid="searxng-deployment-receipt"]')?.textContent ?? '';
  expect(view()).toContain('searxng');
  expect(view()).toContain('ECONNREFUSED');
  const prose = container.textContent ?? '';
  expect(prose).toContain('terminal commands');
  expect(fetchMock.mock.calls.some(([path]) =>
    String(path).endsWith('/configuration/web-search/actions/managed-status'))).toBe(true);
  await mount(() => <GatewayRuntimePanel />);
  expect((container.textContent ?? '')).toContain('stay terminal commands');
});
