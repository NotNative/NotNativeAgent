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
import { WebFetchTrust } from '../pages/web-fetch-trust.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'a'.repeat(64), savedRevision = 'b'.repeat(64);
const view = { schema_version: '1.0', installation_id: 'install_wf', data_id: 'data_wf', scope: 'user',
  source_state: 'present', source_revision: revision, resolution_revision: revision, project_shadowed: false,
  version: 1, trusted_origins: ['https://a.example'], updated_at: '2026-10-06T01:02:03.000Z', application: 'next_fetch' };
const catalog = { schema_version: '1.0', source: 'web_fetch', scope: 'user', fields: [
  { path: 'trusted_origins', classification: 'authority_grant', application: 'next_fetch', type: 'array',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
  { path: 'version', classification: 'generated_state', application: 'next_fetch',
    editability: { available: false, scope: 'user', reason: 'generated_state' } },
  { path: 'updated_at', classification: 'generated_state', application: 'next_fetch',
    editability: { available: false, scope: 'user', reason: 'generated_state' } }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<WebFetchTrust />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const receipt = (operationId: string, override: Record<string, unknown> = {}) => ({ installation_id: view.installation_id,
  data_id: view.data_id, scope: 'user', operation_id: operationId, persistence: 'saved', before_revision: revision,
  persisted_revision: savedRevision, application: 'next_fetch', next_action: 'next_fetch', replayed: false,
  replay_window: 'last_128_operations', ...override });
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('previews and saves a trust grant with exact NNA revision and next-fetch application', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'next_fetch',
      view: { ...view, trusted_origins: ['https://a.example', 'https://docs.example'] } }));
    if (path.endsWith('/save')) return Promise.resolve(json(receipt(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  // The grant list and the stamp the native save writes are both on screen,
  // with the revision prefix that lets an operator see which read they hold.
  expect(container.textContent).toContain('Trusted origins: https://a.example');
  expect(container.textContent).toContain('last saved: 2026-10-06T01:02:03.000Z');
  expect(container.textContent).toContain('revision: ' + revision.slice(0, 12));
  expect([...container.querySelectorAll('li')].map(item => item.textContent)).toContain('https://a.exampleRevoke');
  await type('[data-testid="webfetch-origin-add"]', 'https://docs.example');
  await click('Add');
  await click('Preview native change');
  expect(container.textContent).toContain('https://docs.example');
  expect(container.textContent).toContain('No change has been saved or applied.');
  await click('Save with native revision check');
  expect(container.textContent).toContain('the next web fetch will honor it');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body))).toEqual({ installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user', expected_revision: revision, expected_resolution_revision: revision,
    operations: [{ op: 'trust', origin: 'https://docs.example' }], operation_id: expect.any(String) });
});

it('composes one canonicalizing batch and handles host-case duplicates like the store', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'next_fetch',
      view: { ...view, trusted_origins: ['https://docs.example.com', 'https://z.example'] } }));
    if (path.endsWith('/save')) return Promise.resolve(json(receipt(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="webfetch-origin-add"]', 'https://Docs.Example.com');
  await click('Add');
  await type('[data-testid="webfetch-origin-add"]', 'https://z.example');
  await click('Add');
  await click('Revoke');
  await click('Preview native change');
  await click('Save with native revision check');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  const body = JSON.parse(String(saveCall[1].body));
  expect(body.operations).toEqual([
    { op: 'trust', origin: 'https://docs.example.com' }, { op: 'trust', origin: 'https://z.example' },
    { op: 'revoke', origin: 'https://a.example' }]);
});

it('retains an uncertain save for native receipt lookup after reload', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'next_fetch',
      view: { ...view, trusted_origins: ['https://a.example', 'https://docs.example'] } }));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json(receipt(operationId)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="webfetch-origin-add"]', 'https://docs.example');
  await click('Add'); await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('uncertain outcome');
  await act(async () => root.unmount()); container.remove();
  await mount(); expect(container.textContent).toContain('uncertain outcome');
  await click('Inspect operation');
  expect(container.textContent).toContain('the next web fetch will honor it');
  expect(container.textContent).not.toContain('uncertain outcome');
});

it('releases a terminal unpublished operation so a fresh CAS edit can start', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'next_fetch',
      view: { ...view, trusted_origins: ['https://a.example', 'https://docs.example'] } }));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_failed' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json(receipt(operationId,
      { persistence: 'unpublished', persisted_revision: null, next_action: 'inspect_native_operation' })));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="webfetch-origin-add"]', 'https://docs.example');
  await click('Add'); await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('uncertain outcome');
  await click('Inspect operation');
  expect(container.textContent).toContain('write was not published');
  expect(container.textContent).not.toContain('uncertain outcome');
  expect(sessionStorage.getItem('nnd.webfetch.trust.pending.v1')).toBe('[]');
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[data-testid="webfetch-origin-add"]')).not.toBeNull();
});

it('offers explicit recovery from an expired receipt and requires refresh before another edit', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
      resolution_revision: revision, application: 'next_fetch',
      view: { ...view, trusted_origins: ['https://a.example', 'https://docs.example'] } }));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json({ error: 'operation_not_found' }, 404));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="webfetch-origin-add"]', 'https://docs.example');
  await click('Add'); await click('Preview native change'); await click('Save with native revision check');
  await click('Inspect operation');
  expect(container.textContent).toContain('Clear expired local handle');
  await click('Clear expired local handle');
  expect(sessionStorage.getItem('nnd.webfetch.trust.pending.v1')).toBe('[]');
  expect(container.querySelector<HTMLInputElement>('[data-testid="webfetch-origin-add"]')).toBeNull();
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[data-testid="webfetch-origin-add"]')).not.toBeNull();
});

it('refuses to preview when the composed batch carries a hostile origin', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) throw new Error('preview must not be called for hostile drafts');
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="webfetch-origin-add"]', 'https://user:secret@docs.example');
  const add = [...container.querySelectorAll('button')].find(item => item.textContent === 'Add');
  expect(add?.disabled).toBe(true);
  await type('[data-testid="webfetch-origin-add"]', 'https://docs.example/gone');
  await click('Add');
  await click('Preview native change');
  expect(container.textContent).toContain('outside the bounded trust grammar');
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/preview'))).toBe(false);
});

it('bootstraps trust from an absent source through preview and save', async () => {
  const absent = { schema_version: '1.0', installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    source_state: 'absent', source_revision: 'absent', resolution_revision: 'absent', project_shadowed: false,
    version: 1, trusted_origins: [], updated_at: null, application: 'next_fetch' };
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-fetch')) return Promise.resolve(json(absent));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: 'absent',
      resolution_revision: 'absent', application: 'next_fetch',
      view: { ...absent, trusted_origins: ['https://example.com'], updated_at: '2026-10-06T05:00:00.000Z' } }));
    if (path.endsWith('/save')) return Promise.resolve(json(receipt(JSON.parse(String(init.body)).operation_id,
      { before_revision: 'absent', persisted_revision: savedRevision })));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('source: absent');
  expect(container.textContent).toContain('Trusted origins: none');
  expect(container.textContent).toContain('last saved: not recorded');
  await type('[data-testid="webfetch-origin-add"]', 'https://example.com');
  await click('Add');
  await click('Preview native change');
  expect(container.textContent).toContain('https://example.com');
  await click('Save with native revision check');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body)).expected_revision).toBe('absent');
  expect(container.textContent).toContain('the next web fetch will honor it');
});
