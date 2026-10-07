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
import { ServiceLifecycleControls } from '../pages/service-lifecycle.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const OPERATION = '11111111-2222-4333-8444-555555555555';
const identity = { installation_id: 'install_lc', data_id: 'data_lc', scope: 'user' };
const statusView = () => ({ service: { autostart_enabled: true, configured: true,
  password_source: 'restricted local config', username: 'opencode', hostname: '127.0.0.1',
  port: 4095, bind_url: 'http://127.0.0.1:4095' },
  runtime: { running: false }, login: { supported: false, installed: null, script_path: null },
  environment: { supported: false, skip_start: null, host: null, password_present: null, username: null },
  stale_binding: false });
const resources = { status: () => ({ schema_version: '1.0', ...identity, action: 'status',
  application: 'not_applied', operation_id: OPERATION, status: statusView() }),
  stop: () => ({ schema_version: '1.0', ...identity, action: 'stop', application: 'stop_service',
    operation_id: OPERATION, stopped: false, reason: 'not_running', pid: null,
    environment: { supported: false } }),
  start: () => ({ schema_version: '1.0', ...identity, action: 'start', application: 'start_service',
    operation_id: OPERATION, started: true, reason: null, pid: 777, port: 4095,
    url: 'http://127.0.0.1:4095', runtime: null,
    environment: { supported: true, written: ['OPENCODE_HOST'], removed: [], unchanged: ['OPENCODE_HOST'] } }),
  enable: () => ({ schema_version: '1.0', ...identity, action: 'enable',
    application: 'next_service_start', operation_id: OPERATION, service: statusView().service,
    login: { supported: true, installed: true, script_path: 'C:/startup/NotNativeAgent-OpenCode.vbs' },
    runtime: { running: false } }),
  disable: () => ({ schema_version: '1.0', ...identity, action: 'disable',
    application: 'next_service_start', operation_id: OPERATION, service: statusView().service,
    login: { supported: true, installed: false, script_path: null }, runtime: { running: false } }) };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement;
let root: Root | undefined;async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => root!.render(<ServiceLifecycleControls />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined; runtime.listeners.clear(); });

it('renders the observation honestly, applies inputless verbs, and refuses run verbatim', async () => {
  let verbs: [string, string][] = [];
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    verbs.push([init?.method ?? 'GET', path]);
    const verb = path.split('/').at(-1);
    if (verb === 'status') return Promise.resolve(jsonResponse(resources.status()));
    if (verb === 'stop') return Promise.resolve(jsonResponse(resources.stop()));
    if (verb === 'start') return Promise.resolve(jsonResponse(resources.start()));
    if (verb === 'enable') return Promise.resolve(jsonResponse(resources.enable()));
    if (verb === 'disable') return Promise.resolve(jsonResponse(resources.disable()));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const panel = () => container.querySelector('[data-testid="lifecycle-status"]')?.textContent ?? '';
  expect(panel()).toContain('service enabled');
  expect(panel()).toContain('basic auth configured (password source: restricted local config)');
  expect(panel()).toContain('not running');
  expect((panel().match(/restricted local config/g) ?? []).length).toBe(1);
  expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('password>');
  // Start applies immediately and the receipt reports the honest summary.
  await click('Start');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('runtime started at http://127.0.0.1:4095');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('start_service');
  // Nothing was running: stop is an honest no-op receipt, and run is refused.
  await click('Stop');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('nothing was running');
  // Enable wires the Startup script and reports the next-service-start class.
  await click('Enable login auto-start');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('login auto-start wired: installed');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('applies at the next service start');
  // Disable is its own census verb, not the mirror image of enable: it unwires the
  // Startup script and says which of the two outcomes the receipt recorded.
  await click('Disable login auto-start');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('login auto-start unwired: removed');
  expect(container.querySelector('[data-testid="lifecycle-receipt"]')?.textContent)
    .toContain('applies at the next service start');
  // 'run' has no control to click, so its coverage is the sentence that says why,
  // plus proof that no such button exists and no request was ever aimed at it.
  expect(container.textContent)
    .toContain('the generic managed foreground runtime (run) is driven by the detached start');
  expect([...container.querySelectorAll('button')].map(button => button.textContent))
    .not.toContain('Run');
  const paths = verbs.map(([, path]) => path);
  for (const path of paths) expect(path).not.toContain('/actions/run');
  expect(verbs.every(([, path]) => path.split('/').at(-1) === 'status' || path.endsWith('/stop') || path.endsWith('/start') || path.endsWith('/enable') || path.endsWith('/disable'))).toBe(true);
  expect(verbs.filter(([method]) => method === 'POST').every(([, path]) => path.split('/').at(-1) !== 'status')).toBe(true);
  // A wiring-platform refusal keeps its sentence and the forwarded code.
  fetchMock.mockImplementation((path: string) => path.split('/').at(-1) === 'stop'
    ? Promise.resolve(jsonResponse({ error: { code: 'opencode_identity_unverifiable' } }, 503))
    : Promise.resolve(jsonResponse(resources.status())));
  await click('Stop');
  expect(container.textContent).toContain('refuses to stop');
  expect((container.textContent.match(/opencode_identity_unverifiable/g) ?? []).length)
    .toBeGreaterThanOrEqual(1);
  const methods = verbs.map(([method]) => method);
  expect(methods.every(method => method === 'GET' || method === 'POST')).toBe(true);
});
