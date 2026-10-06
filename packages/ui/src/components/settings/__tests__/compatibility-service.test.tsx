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
import { CompatibilityServiceSettings } from '../pages/compatibility-service.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const identity = { installation_id: 'install_compat', data_id: 'data_compat', scope: 'user' };
const SECRET = 'c'.repeat(24);
const hex = (char: string) => char.repeat(64);
const view = (part: Record<string, unknown> = {}) => ({ ...identity, schema_version: '1.0',
  source_state: 'absent', source_revision: 'absent', resolution_revision: 'absent',
  project_shadowed: false, version: 1, enabled: false, hostname: '127.0.0.1', port: 4095,
  username: 'opencode', password: { configured: false, source: null }, updated_at: null,
  application: 'next_service_start', ...part });
const catalog = () => ({ schema_version: '1.0', source: 'compatibility_service', scope: 'user',
  fields: [
    { path: 'version', classification: 'generated_state', application: 'next_service_start',
      editability: { available: false, scope: 'user', reason: 'generated_state' } },
    { path: 'enabled', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'hostname', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'port', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'username', classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'password', classification: 'operator_setting', type: 'secret',
      operations: ['replace_secret', 'clear_secret'], application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
    { path: 'updated_at', classification: 'generated_state', application: 'next_service_start',
      editability: { available: false, scope: 'user', reason: 'generated_state' } }] });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement;
let root: Root | undefined;async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => root!.render(<CompatibilityServiceSettings />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await settle();
}
async function select(selector: string) { const radio = container.querySelector<HTMLInputElement>(selector);
  if (!radio) throw new Error('missing ' + selector); await act(async () => radio.click()); await settle(); }
async function check(selector: string) {
  const box = container.querySelector<HTMLInputElement>(selector);
  if (!box) throw new Error('missing ' + selector);
  await act(async () => box.click()); await settle();
}
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined; runtime.listeners.clear(); });

it('stages the wire identity and a secret replace, previews, saves, and reloads natively', async () => {
  let revision = 'absent';
  let stored = false;
  let savedOperationId = '';
  const current = (absent: boolean) => {
    const configured = stored;
    return { ...view({ enabled: !absent, port: absent ? 4095 : 4096,
      password: configured ? { configured: true, source: 'restricted local config' }
        : { configured: false, source: null },
      updated_at: absent ? null : '2026-10-06T02:00:00.000Z' }),
      ...(absent ? {} : { source_state: 'present', source_revision: revision, resolution_revision: revision }) };
  };
  const credentialFor = (action: string) => action === 'replace'
    ? { configured: true, source: 'restricted local config' }
    : action === 'clear' ? { configured: false, source: null }
      : stored ? { configured: true, source: 'restricted local config' }
        : { configured: false, source: null };
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/compatibility-service') && method === 'GET') {
      return Promise.resolve(jsonResponse(current(!stored)));
    }
    if (path.endsWith('/compatibility-service/catalog')) return Promise.resolve(jsonResponse(catalog()));
    if (path.endsWith('/compatibility-service/preview') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { expected_revision: string;
        view: { enabled: boolean; hostname: string; port: number; username: string };
        password: { action: string; value?: string } };
      expect(body.expected_revision).toBe(revision);
      const merged = { ...current(true), enabled: body.view.enabled, hostname: body.view.hostname,
        port: body.view.port, username: body.view.username, updated_at: '2026-10-06T02:30:00.000Z',
        password: credentialFor(body.password.action) };
      process.stderr.write(`PREVIEWBODY ${JSON.stringify(merged)}\n`);
      return Promise.resolve(jsonResponse({ valid: true, application: 'next_service_start',
        expected_revision: revision, resolution_revision: revision,
        view: merged }));
    }
    if (path.endsWith('/compatibility-service/save') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { password: { action: string; value?: string };
        operation_id: string };
      expect(body.password.value).toBe(SECRET);
      expect(body.operation_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/u);
      savedOperationId = body.operation_id;
      revision = hex('f'); stored = true;
      return Promise.resolve(jsonResponse({ ...identity, operation_id: body.operation_id,
        persistence: 'saved', before_revision: 'absent', persisted_revision: revision,
        application: 'next_service_start', next_action: 'next_service_start', replayed: false,
        replay_window: 'last_128_operations' }));
    }
    throw new Error('unexpected ' + path + ' ' + method);
  });
  await mount();
  const status = () => container.querySelector('[data-testid="compat-status"]')?.textContent ?? '';
  expect(status()).toContain('4095');
  expect(status()).toContain('not configured');
  await check('[data-testid="compat-enabled"]');
  await type('[data-testid="compat-port"]', '4096');
  await select('[data-testid="compat-password-replace"]');
  await type('[data-testid="compat-password-value"]', SECRET);
  await click('Preview native change');
  const preview = container.querySelector('[data-testid="compat-preview"]')?.textContent ?? '';
  expect(preview).toContain('on');
  expect(preview).toContain('4096');
  expect(preview).toContain('present (restricted local config)');
  expect((container.textContent ?? '').includes(SECRET)).toBe(false);
  await click('Save with native revision check');
  expect((container.textContent ?? '').includes(savedOperationId)).toBe(true);
  expect((container.textContent ?? '').includes('Saved in NNA')).toBe(true);
  const reloaded = status();
  expect(reloaded).toContain('4096');
  expect(reloaded).toContain('on');
  expect(reloaded).toContain('present (restricted local config)');
  expect((container.textContent ?? '').includes(SECRET)).toBe(false);
});

it('surfaces the honest bind refusal, corrupt-store refusal, revision conflict, and auth gate', async () => {
  let revision = 'absent';
  const current = () => view();
  const merger = (action: string, body: { view: { hostname: string } }) => {
    if (body.view.hostname === '0.0.0.0' && action === 'keep') {
      return Promise.resolve(jsonResponse({ error: { code: 'opencode_bind_exposed_requires_password' } }, 400));
    }
    return Promise.resolve(jsonResponse({ valid: true, application: 'next_service_start',
      expected_revision: revision, resolution_revision: revision,
      view: { ...current(), updated_at: '2026-10-06T02:30:00.000Z',
        password: action === 'replace' ? { configured: true, source: 'restricted local config' }
          : { configured: false, source: null } } }));
  };
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/compatibility-service') && method === 'GET') return Promise.resolve(jsonResponse(current()));
    if (path.endsWith('/compatibility-service/catalog')) return Promise.resolve(jsonResponse(catalog()));
    if (path.endsWith('/compatibility-service/preview') && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as { view: { hostname: string };
        password: { action: string } };
      return merger(body.password.action, body as never);
    }
    throw new Error('unexpected ' + path + ' ' + method);
  });
  await mount();
  await type('[data-testid="compat-hostname"]', '0.0.0.0');
  await click('Preview native change');
  expect((container.textContent ?? '').includes('A bind beyond loopback needs Basic auth credentials')).toBe(true);
  await type('[data-testid="compat-hostname"]', '127.0.0.1');
  await select('[data-testid="compat-password-replace"]');
  await type('[data-testid="compat-password-value"]', SECRET);
  await click('Preview native change');
  expect((container.querySelector('[data-testid="compat-preview"]')?.textContent ?? '')
    .includes('present (restricted local config)')).toBe(true);

  await act(async () => root!.unmount()); container.remove(); root = undefined; fetchMock.mockReset();
  fetchMock.mockImplementation((path: string) => path.endsWith('/compatibility-service')
    ? Promise.resolve(jsonResponse({ error: { code: 'opencode_config_version_unsupported' } }, 400))
    : Promise.resolve(jsonResponse(catalog())));
  await mount();
  expect((container.textContent ?? '').includes('not readable by this NNA build')).toBe(true);
  expect(container.querySelector('[data-testid="compat-status"]')).toBeNull();

  fetchMock.mockReset();
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.endsWith('/compatibility-service') && method === 'GET') return Promise.resolve(jsonResponse(current()));
    if (path.endsWith('/compatibility-service/catalog')) return Promise.resolve(jsonResponse(catalog()));
    if (path.endsWith('/compatibility-service/preview'))
      return Promise.resolve(jsonResponse({ error: { code: 'manifest_revision_conflict' } }, 409));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await click('Preview native change');
  expect((container.textContent ?? '').includes('Refresh and preview again.')).toBe(true);

  await act(async () => root!.unmount()); container.remove(); root = undefined;
  await act(async () => useAuthSessionStore.setState({ status: 'signed-out' } as never));
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(current())));
  await mount();
  expect((container.textContent ?? '').includes('Sign in to inspect compatibility service settings.')).toBe(true);
});
