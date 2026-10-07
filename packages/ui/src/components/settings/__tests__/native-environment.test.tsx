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
import { NativeEnvironment } from '../pages/native-environment.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const NAMES = ['NNA_HOME', 'NNA_PROVIDER_ENDPOINT', 'NNA_MODEL', 'NNA_REDUCED_MOTION', 'NO_COLOR',
  'NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD'];
const SECRETS = new Set(['NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD']);
const entry = (name: string, present = true, value = 'value-text') =>
  ({ name, secret: SECRETS.has(name), present, value: present && !SECRETS.has(name) ? value : null });
const view = { installation_id: 'install_ws', data_id: 'data_ws', scope: 'user', schema_version: '1.0',
  observation_digest: 'ab'.repeat(32), observed: NAMES.map((name) => entry(name)),
  environment_scope: 'service_process' };
const catalog = { schema_version: '1.0', source: 'environment', scope: 'user', fields: NAMES.map((name) => ({
  path: name, classification: SECRETS.has(name) ? 'operator_credential' : 'operator_setting',
  application: 'restart_service', editability: { available: false, scope: 'user', reason: 'process_environment' } })) };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<NativeEnvironment />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
const live = (over: Record<string, Record<string, unknown>> = {}) => ({ ...view, observed: view.observed.map((item) => {
  const change = over[item.name];
  if (!change) return item;
  if (change.present === false || SECRETS.has(item.name)) return { ...item, ...change, value: null };
  if (change.value !== undefined) return { ...item, ...change };
  return { ...item, ...change };
}) });
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('reads the observation with withheld credential values and honest empty/absent rows', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/environment')) return Promise.resolve(json(live({
      NO_COLOR: { present: false }, NNA_MODEL: { value: '' } })));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    throw new Error('unexpected ' + path);
  });
  await mount();
  const text = container.textContent ?? '';
  expect(text).toContain('NNA_REDUCED_MOTION');
  const cell = (name: string) => container.querySelector(`[data-testid="native-environment-${name.toLowerCase()}"]`)
    ?.textContent ?? '';
  expect(cell('nna_home')).toBe('value-text');
  expect(cell('nna_provider_endpoint')).toBe('value-text');
  expect(cell('nna_reduced_motion')).toBe('value-text');
  expect(cell('nna_model')).toBe('(empty value)');
  expect(cell('no_color')).toBe('not set in the service process');
  expect(cell('nna_telegram_bot_token')).toBe('set · value withheld');
  expect(cell('opencode_server_password')).toBe('set · value withheld');
  // Seven census rows, one line each, and the digest that ties the read to
  // one observation. The catalog has arrived, so the pending caveat is gone.
  expect(container.querySelectorAll('[data-testid="native-environment-table"] li')).toHaveLength(7);
  expect(text).toContain('Observation digest abababababab');
  expect(text).not.toContain('(catalog pending)');
  expect(text).toContain('service process');
  await click('Refresh');
  expect(fetchMock.mock.calls.filter(([path]) => String(path).endsWith('/environment')).length).toBe(2);
});

it('maps errors to specific sentences and pauses for auth and authority', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/environment')) return Promise.resolve(json(
      { error: { code: 'nnd_environment_value_too_large' } }, 400));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('exceeded the projection bound');
  await act(async () => root.unmount()); container.remove();
  fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
  await act(async () => useAuthSessionStore.setState({ status: 'signed-out' } as never));
  await mount();
  expect(container.textContent).toContain('Sign in to read the native environment observation.');
  useAuthSessionStore.getState().markOk();
  await settle();
  expect(container.querySelector('[data-testid="native-environment-table"]')).toBeNull();
});
