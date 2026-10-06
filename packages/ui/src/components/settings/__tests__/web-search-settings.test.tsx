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
import { WebSearchSettings } from '../pages/web-search-settings.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'c'.repeat(64), savedRevision = 'd'.repeat(64);
const profile = (id: string, endpoint = 'https://a.example', displayName = `${id} search`) => ({ id, display_name: displayName,
  provider: 'searxng', endpoint, managed: false });
const view = { schema_version: '1.0', installation_id: 'install_ws', data_id: 'data_ws', scope: 'user',
  source_state: 'present', source_revision: revision, resolution_revision: revision, project_shadowed: false,
  version: 2, enabled: true,
  profiles: [profile('docs'), profile('work', 'https://work.example')], application: 'next_search' };
const catalog = { schema_version: '1.0', source: 'web_search', scope: 'user', fields: [
  { path: 'enabled', classification: 'operator_setting', application: 'next_search',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
  { path: 'profiles', classification: 'operator_setting', application: 'next_search', type: 'array',
    operations: ['add_profile', 'promote_profile', 'remove_profile'],
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } },
  { path: 'version', classification: 'generated_state', application: 'next_search',
    editability: { available: false, scope: 'user', reason: 'generated_state' } }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let container: HTMLDivElement; let root: Root;
async function settle() { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); }
async function mount() { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<WebSearchSettings />)); await settle(); }
async function click(label: string) { const button = [...container.querySelectorAll('button')]
  .filter(item => item.textContent === label).at(-1);
  if (!button) throw new Error('missing ' + label); await act(async () => button.click()); await settle(); }
async function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function toggle(selector: string) {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  await act(async () => input.click());
}
async function addProfile(name = 'Docs new', endpoint = 'https://docs.example/search/') {
  await type('[data-testid="websearch-name-add"]', name);
  await type('[data-testid="websearch-endpoint-add"]', endpoint);
  await click('Add profile');
}
const receipt = (operationId: string, override: Record<string, unknown> = {}) => ({ installation_id: view.installation_id,
  data_id: view.data_id, scope: 'user', operation_id: operationId, persistence: 'saved', before_revision: revision,
  persisted_revision: savedRevision, application: 'next_search', next_action: 'next_search', replayed: false,
  replay_window: 'last_128_operations', ...override });
const previewOf = (over: Record<string, unknown>) => ({ valid: true, expected_revision: revision,
  resolution_revision: revision, application: 'next_search', view: { ...view, ...over } });
beforeEach(() => { fetchMock.mockReset(); sessionStorage.clear(); runtime.key = 'native-runtime';
  useAuthSessionStore.getState().markOk(); });
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); runtime.listeners.clear(); });

it('previews and saves a profile add with exact NNA revision and next-search application', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json(previewOf({
      profiles: [profile('docs'), profile('work', 'https://work.example'),
        profile('docs-new', 'https://docs.example', 'Docs new')] })));
    if (path.endsWith('/save')) return Promise.resolve(json(receipt(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await addProfile('Docs new', 'https://docs.example/search/');
  expect(container.textContent).toContain('Docs new');
  await click('Preview native change');
  expect(container.textContent).toContain('No change has been saved or applied.');
  await click('Save with native revision check');
  expect(container.textContent).toContain('the next web search will honor it');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body))).toEqual({ installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user', expected_revision: revision, expected_resolution_revision: revision,
    operations: [{ op: 'add_profile', display_name: 'Docs new', endpoint: 'https://docs.example' }],
    operation_id: expect.any(String) });
});

it('composes one canonicalizing batch across add, disable, promote, and remove', async () => {
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json(previewOf({
      enabled: false, profiles: [profile('work', 'https://work.example'), profile('docs'),
        profile('zdc', 'https://z.example', 'Zdc')] })));
    if (path.endsWith('/save')) return Promise.resolve(json(receipt(JSON.parse(String(init.body)).operation_id)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await addProfile('Zdc', 'https://z.example');
  await toggle('[data-testid="websearch-enabled"]');
  const workRow = [...container.querySelectorAll('li')]
    .find(item => item.textContent?.startsWith('work:'));
  const primary = [...(workRow?.querySelectorAll('button') ?? [])]
    .find(button => button.textContent === 'Make primary');
  await act(async () => primary!.click()); await settle();
  await click('Preview native change');
  await click('Save with native revision check');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body)).operations).toEqual([
    { op: 'add_profile', display_name: 'Zdc', endpoint: 'https://z.example' },
    { op: 'set_enabled', enabled: false },
    { op: 'promote_profile', id: 'work' }]);
});

it('retains an uncertain save for native receipt lookup after reload', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json(previewOf({
      enabled: true, profiles: [profile('docs'), profile('work', 'https://work.example'),
        profile('docs-new', 'https://docs.example', 'Docs new')] })));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json(receipt(operationId)));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await addProfile(); await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('uncertain outcome');
  await act(async () => root.unmount()); container.remove();
  await mount(); expect(container.textContent).toContain('uncertain outcome');
  await click('Inspect operation');
  expect(container.textContent).toContain('the next web search will honor it');
  expect(container.textContent).not.toContain('uncertain outcome');
});

it('releases a terminal unpublished operation so a fresh CAS edit can start', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json(previewOf({
      enabled: true, profiles: [profile('docs'), profile('work', 'https://work.example'),
        profile('docs-new', 'https://docs.example', 'Docs new')] })));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_failed' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json(receipt(operationId,
      { persistence: 'unpublished', persisted_revision: null, next_action: 'inspect_native_operation' })));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await addProfile(); await click('Preview native change'); await click('Save with native revision check');
  expect(container.textContent).toContain('uncertain outcome');
  await click('Inspect operation');
  expect(container.textContent).toContain('write was not published');
  expect(container.textContent).not.toContain('uncertain outcome');
  expect(sessionStorage.getItem('nnd.websearch.settings.pending.v1')).toBe('[]');
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[data-testid="websearch-name-add"]')).not.toBeNull();
});

it('offers explicit recovery from an expired receipt and requires refresh before another edit', async () => {
  let operationId = '';
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json(previewOf({
      enabled: true, profiles: [profile('docs'), profile('work', 'https://work.example'),
        profile('docs-new', 'https://docs.example', 'Docs new')] })));
    if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
      return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
    if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json({ error: 'operation_not_found' }, 404));
    throw new Error('unexpected ' + path);
  });
  await mount();
  await addProfile(); await click('Preview native change'); await click('Save with native revision check');
  await click('Inspect operation');
  expect(container.textContent).toContain('Clear expired local handle');
  await click('Clear expired local handle');
  expect(sessionStorage.getItem('nnd.websearch.settings.pending.v1')).toBe('[]');
  expect(container.querySelector<HTMLInputElement>('[data-testid="websearch-name-add"]')).toBeNull();
  await click('Refresh');
  expect(container.querySelector<HTMLInputElement>('[data-testid="websearch-name-add"]')).not.toBeNull();
});

it('refuses to preview a hostile or empty composition without contacting NNA', async () => {
  fetchMock.mockImplementation((path: string) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(view));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) throw new Error('preview must not be called for hostile drafts');
    throw new Error('unexpected ' + path);
  });
  await mount();
  await type('[data-testid="websearch-endpoint-add"]', 'https://user:secret@docs.example');
  const add = [...container.querySelectorAll('button')].find(item => item.textContent === 'Add profile');
  expect(add?.disabled).toBe(true);
  await click('Preview native change');
  expect(container.textContent).toContain('No enabled toggle, profile, or primary choice differs');
  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/preview'))).toBe(false);
});

it('surfaces the honest enable-refusal and bootstraps from an absent source with domain parity', async () => {
  const absent = { schema_version: '1.0', installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    source_state: 'absent', source_revision: 'absent', resolution_revision: 'absent', project_shadowed: false,
    version: 2, enabled: false, profiles: [], application: 'next_search' };
  fetchMock.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith('/web-search')) return Promise.resolve(json(absent));
    if (path.endsWith('/catalog')) return Promise.resolve(json(catalog));
    if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: 'absent',
      resolution_revision: 'absent', application: 'next_search',
      view: { ...absent, enabled: true, profiles: [profile('docs-search', 'https://docs.example', 'Docs Search')] } }));
    if (path.endsWith('/save')) return Promise.resolve(json(receipt(JSON.parse(String(init.body)).operation_id,
      { before_revision: 'absent', persisted_revision: savedRevision })));
    throw new Error('unexpected ' + path);
  });
  await mount();
  expect(container.textContent).toContain('WebSearch is disabled');
  expect(container.textContent).toContain('source: absent');
  await toggle('[data-testid="websearch-enabled"]');
  await click('Preview native change');
  expect(container.textContent).toContain('cannot be enabled while no profile exists');
  await click('Refresh');
  await addProfile('Docs Search', 'https://docs.example');
  await click('Preview native change');
  expect(container.textContent).toContain('docs-search');
  await click('Save with native revision check');
  const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
  expect(JSON.parse(String(saveCall[1].body)).expected_revision).toBe('absent');
  expect(container.textContent).toContain('the next web search will honor it');
});

