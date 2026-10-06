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
import { SecretActionsConsole } from '../pages/secret-console.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const ID = 'sec_00000000-0000-4000-8000-000000000000';
const STAMP = '2026-10-06T16:00:00.000Z';
const identity = { realm: 'nna.local', scope: null, metadata: {}, enabled: true, createdAt: STAMP,
  updatedAt: STAMP, rotatedAt: null, lastUsedAt: null, useCount: 0 };
const secret = (label = 'Registry credential', kind = 'api_key', fields = ['apikey']) => ({
  id: ID, label, kind, fields, ...identity });
const audit = (event = 'secret.created', outcome = 'succeeded') => ({ format: 1,
  id: 'secret_event_00000000-0000-4000-8000-000000000000', at: STAMP, event, outcome,
  realm: 'nna.local', secretId: ID, scope: null, consumer: null, destination: null, purpose: null,
  sessionId: null, reviewerDecisionId: null, reason: null });
let container: HTMLDivElement;
let root: Root | undefined;
const requests: [string, string | undefined][] = [];
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); await act(async () => root!.render(<SecretActionsConsole />)); await settle(); }
function inputOf(placeholder: string): HTMLInputElement {
  const item = [...container.querySelectorAll('input')]
    .find(entry => (entry as HTMLInputElement).placeholder === placeholder) as HTMLInputElement;
  if (!item) throw new Error('missing ' + placeholder);
  return item;
}
async function type(placeholder: string, text: string) { const item = inputOf(placeholder);
  const value = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => { if (value) value.call(item, text); else item.value = text;
    item.dispatchEvent(new window.Event('input', { bubbles: true })); }); await settle(); }
async function click(label: string) { const target = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!target) throw new Error('missing ' + label); await act(async () => target.click()); await settle(); }
beforeEach(() => { fetchMock.mockReset(); requests.length = 0; sessionStorage.clear();
  runtime.key = 'native-runtime'; useAuthSessionStore.getState().markOk();
  fetchMock.mockImplementation((path: string, init?: RequestInit) => {
    requests.push([path, init?.method]);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({
      secret: { ...secret(String(body.label)), ...identity } }), { status: 201 }));
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));

  });
});
async function defaultMock() { fetchMock.mockImplementation((path: string, init?: RequestInit) => {
  requests.push([path, init?.method]);
  if (String(path) === '/api/v1/secrets' && init?.method === 'GET') {
    return Promise.resolve(new Response(JSON.stringify({ secrets: [secret()] }), { status: 200 }));
  }
  if (String(path).startsWith('/api/v1/secrets/audit')) {
    return Promise.resolve(new Response(JSON.stringify({ events: [audit()] }), { status: 200 }));
  }
  if (String(path).endsWith('/values')) {
    return Promise.resolve(new Response(JSON.stringify({ secret: { ...secret(),
      rotatedAt: STAMP } }), { status: 200 }));
  }
  if (String(path).endsWith('/status')) {
    return Promise.resolve(new Response(JSON.stringify({ secret: { ...secret(),
      enabled: false } }), { status: 200 }));
  }
  if (init?.method === 'PATCH') {
    return Promise.resolve(new Response(JSON.stringify({ secret: { ...secret('Renamed') } }),
      { status: 200 }));
  }
  if (init?.method === 'DELETE') return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  if (init?.method === 'POST') return Promise.resolve(new Response(JSON.stringify({
    secret: secret('Vault token') }), { status: 201 }));
  return Promise.resolve(new Response(JSON.stringify({ secrets: [] }), { status: 200 }));
}); }
afterEach(() => { act(() => { if (root) root.unmount(); }); container?.remove(); root = undefined;
  runtime.listeners.clear(); });

it('drives all seven census actions with redacted receipts and never re-renders values', async () => {
  await defaultMock();
  await mount();
  const roster = () => container.querySelector('[data-testid="secret-roster"]')?.textContent ?? '';
  expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/secrets');
  expect(roster()).toContain('Registry credential · api_key · global (null scope)');
  expect(roster()).toContain('fields [apikey]');
  expect(roster()).toContain('native audit');
  // create → POST with values sent once; the receipt is the redacted label.
  await type('label', 'Vault token'); await type('field name', 'token');
  await type('field value', 'SENT-ONCE-VALUE'); await click('Create secret');
  expect(container.querySelector('[data-testid="secret-receipt"]')?.textContent).toContain('created Vault token');
  const posted = requests.find(([path, method]) => method === 'POST');
  expect(posted?.[0]).toBe('/api/v1/secrets');
  // update → rename through the edit panel; scope stays values-free.
  await click('Edit label/scope/metadata…'); await type('label (Registry credential)', 'Renamed');
  await click('Apply');
  expect(requests.find(([path, method]) => method === 'PATCH' && path === `/api/v1/secrets/${ID}`)).toBeTruthy();
  // rotate → PUT values clears the inputs after send and shows no value back.
  await click('Rotate values…'); await type('new apikey', 'ROTATED-ONCE'); await click('Set new values');
  expect(requests.find(([path, method]) => method === 'PUT' && path === `/api/v1/secrets/${ID}/values`)).toBeTruthy();
  expect([...container.querySelectorAll('input')].some(entry => (entry as HTMLInputElement).type
    === 'password' && (entry as HTMLInputElement).value.includes('ROTATED-ONCE'))).toBe(false);
  // enable/disable → PATCH status; once disabled the roster's absence keeps the audit row only.
  await click('Disable');
  expect(requests.find(([path, method]) => method === 'PATCH' && String(path).endsWith('/status'))).toBeTruthy();
  // delete → DELETE and the value never comes back.
  await click('Delete');
  expect(requests.find(([path, method]) => method === 'DELETE' && path === `/api/v1/secrets/${ID}`)).toBeTruthy();
  for (const [path] of requests) expect(path).not.toContain('/use');
});
