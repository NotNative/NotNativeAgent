// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { beginAuthorityRecovery, finishAuthorityRecovery } from '../../../sync/authority-sync.ts';
import { AgentSettingsEditor } from '../pages/agent-settings-editor.tsx';
import { AGENT_SETTINGS } from '../pages/agent-settings-fields.ts';

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
const runtime = vi.hoisted(() => ({ key: 'local', origin: 'http://127.0.0.1:3000' }));
vi.mock('../../../lib/runtime-switch.ts', async original => ({ ...(await original<object>()), getRuntimeKey: () => runtime.key }));
vi.mock('../../../lib/runtime-url.ts', async original => ({ ...(await original<object>()), getApiBaseUrl: () => runtime.origin }));
const values: Record<string, string | number | boolean | string[] | null> = {
  application_system_prompt: 'Original instructions', persistence: 'durable', 'recovery.max_model_steps': 1024,
  'recovery.local_retry_limit': 3, 'recovery.ladder': ['nudge', 'compact', 'compact', 'compact'],
  'recovery.turn_wall_clock_ms': null, approval_timeout_ms: 60000, tool_concurrency: 1,
  context_limit_bytes: 2097152, context_compression_threshold: .4, context_compression_level_2_threshold: .55,
  context_compression_level_3_threshold: .7, context_compaction_threshold: .75,
  'memory.enabled': true, 'memory.required': false, 'memory.timeout_ms': 750, 'memory.max_items': 8, 'memory.max_bytes': 16384,
};
const view: NativeConfigurationView = { schema_version: '1.0', installation_id: 'nna_test', data_id: 'data_test', scope: 'user',
  source_state: 'present', source_revision: 'a'.repeat(64), resolution_revision: 'b'.repeat(64), source_revisions: [], application: 'not_applied',
  fields: Object.entries(values).map(([path, value]) => ({ path, catalog_path: path, explicit: { present: false },
    effective: { present: true, value, source: 'compiled_default' }, application: 'not_applied' })) };
const catalog = { schema_version: '1.0', authority: 'descriptive_only', fields: AGENT_SETTINGS.map(field => ({ path: field.path,
  type: field.type, ...(field.type === 'enum' ? { enum: ['durable', 'ephemeral'] } : {}), classification: 'operator_setting',
  editability: { available: true, generic_editable: true, scope: 'user', required_permission: 'nnd.configuration.manage',
    ...(['memory.enabled', 'memory.required'].includes(field.path) ? { coupled_fields: ['memory.enabled', 'memory.required'] } : {}) } })) };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let root: Root, node: HTMLDivElement;
const sent = () => vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));
function button(label: string) { const found = [...node.querySelectorAll('button')].find(row => (row.getAttribute('aria-label') ?? row.textContent) === label);
  if (!found) throw new Error(`Missing ${label}`); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function mount() {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(<I18nProvider><AgentSettingsEditor view={view} groups={['policy', 'context', 'memory']} onReload={vi.fn()} /></I18nProvider>));
}
async function input(label: string, value: string) {
  const control = node.querySelector(`[aria-label="${label}"]:not(button)`)!;
  await act(async () => { if (control instanceof HTMLSelectElement) { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); }
    else { const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); } });
}
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true; vi.resetAllMocks(); sessionStorage.clear(); runtime.key = 'local'; runtime.origin = 'http://127.0.0.1:3000';
  const token = beginAuthorityRecovery('local'); finishAuthorityRecovery('local', token, true);
  vi.mocked(runtimeFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/catalog')) return json(catalog);
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith('/preview')) return json({ valid: true, expected_revision: view.source_revision,
      resolution_revision: view.resolution_revision, application: 'not_applied', view });
    return json({ installation_id: view.installation_id, data_id: view.data_id, scope: 'user', operation_id: request.operation_id,
      persistence: 'saved', persisted_revision: 'c'.repeat(64), before_revision: view.source_revision, application: 'not_applied', replayed: false });
  });
});
afterEach(() => { act(() => root?.unmount()); node?.remove(); sessionStorage.clear(); });

it.each([
  ['application_system_prompt', 'Application instructions', 'New instructions', 'New instructions'],
  ['persistence', 'Conversation persistence', 'ephemeral', 'ephemeral'],
  ['recovery.max_model_steps', 'Maximum model steps', '256', 256],
  ['recovery.local_retry_limit', 'Local retry limit', '4', 4],
  ['recovery.turn_wall_clock_ms', 'Turn time limit (ms)', '0', 0],
  ['approval_timeout_ms', 'Approval wait (ms)', '12000', 12000], ['tool_concurrency', 'Concurrent tools', '2', 2],
  ['context_limit_bytes', 'Context byte ceiling', '1048576', 1048576],
  ['context_compression_threshold', 'First compression threshold', '0.3', .3],
  ['context_compression_level_2_threshold', 'Second compression threshold', '0.6', .6],
  ['context_compression_level_3_threshold', 'Third compression threshold', '0.72', .72],
  ['context_compaction_threshold', 'Full compaction threshold', '0.8', .8],
  ['memory.timeout_ms', 'Memory retrieval timeout (ms)', '1000', 1000], ['memory.max_items', 'Maximum retrieved items', '4', 4],
  ['memory.max_bytes', 'Maximum retrieved bytes', '8192', 8192],
])('previews typed %s, then publishes the exact revision-bound operation', async (path, label, draft, expected) => {
  await mount(); await click(`Edit ${label}`); expect(node.textContent).not.toContain('Save to NNA');
  await input(String(label), String(draft)); await click('Preview change');
  expect(sent()[0]?.body).toMatchObject({ expected_revision: 'a'.repeat(64), expected_resolution_revision: 'b'.repeat(64), operations: [{ op: 'set', field: path, value: expected }] });
  await click('Save to NNA'); expect(sent()[1]?.body).toEqual({ ...sent()[0]!.body, operation_id: expect.any(String) });
  expect(node.textContent).toContain('Restart NNA to load them'); expect(button(`Edit ${label}`).closest('fieldset')?.disabled).toBe(true);
});

it.each([['Optional memory retrieval', false], ['Require memory', true]])('previews both resolved memory flags when changing %s', async (label, expected) => {
  await mount(); await click(`Edit ${label}`);
  await act(async () => (node.querySelector(`[aria-label="${label}"]:not(button)`) as HTMLInputElement).click());
  const projected = { ...view, fields: view.fields.map(row => row.path === 'memory.enabled' || row.path === 'memory.required'
    ? { ...row, effective: { present: true as const, value: expected, source: 'user' } } : row) };
  vi.mocked(runtimeFetch).mockResolvedValueOnce(json({ valid: true, expected_revision: view.source_revision,
    resolution_revision: view.resolution_revision, application: 'not_applied', view: projected }));
  await click('Preview change'); expect(sent()[0]?.body.operations[0].value).toBe(expected);
  expect(node.querySelector('[role="status"]')?.textContent).toContain(`Optional memory retrieval${expected}Require memory${expected}`);
});

it.each(['manifest_revision_conflict', 'nnd_configuration_resolution_conflict', 'configuration_source_shadowed'])(
  'preserves input on %s, invalidates preview, and releases only the rejected operation', async code => {
  await mount(); await click('Edit Maximum model steps'); await input('Maximum model steps', '200'); await click('Preview change');
  vi.mocked(runtimeFetch).mockResolvedValueOnce(json({ error: { code } }, 409));
  await click('Save to NNA'); expect(node.querySelector('[aria-label="Maximum model steps"]')?.getAttribute('value')).toBe('200');
  expect(node.textContent).toContain('Your edit is preserved'); expect(node.textContent).not.toContain('Save to NNA');
  expect(node.textContent).not.toContain('Save outcome is unknown'); expect(button('Preview change').closest('fieldset')?.disabled).toBe(false);
  await click('Preview change'); await click('Save to NNA'); expect(node.textContent).toContain('User defaults saved');
  expect(sent()[3]?.body.operation_id).not.toBe(sent()[1]?.body.operation_id);
});

it('keeps unsupported and unreadable settings inert instead of editing an invented empty value', async () => {
  vi.mocked(runtimeFetch).mockResolvedValueOnce(json({ ...catalog, fields: catalog.fields.filter(field => field.path !== 'tool_concurrency') }));
  const unreadable = { ...view, fields: view.fields.map(row => row.path === 'application_system_prompt'
    ? { ...row, explicit: { present: true as const, value_unavailable: true as const } } : row) };
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root.render(<I18nProvider><AgentSettingsEditor view={unreadable} groups={['policy']} onReload={vi.fn()} /></I18nProvider>));
  expect(button('Edit Concurrent tools').disabled).toBe(true); expect(button('Edit Application instructions').disabled).toBe(true);
  expect(node.querySelector('textarea')).toBeNull(); expect(sent()).toHaveLength(0);
});

it('retains unknown save outcomes for inspection instead of allowing duplicate publication', async () => {
  await mount(); await click('Edit Context byte ceiling'); await input('Context byte ceiling', '1048576'); await click('Preview change');
  vi.mocked(runtimeFetch).mockRejectedValueOnce(new Error('connection lost'));
  await click('Save to NNA'); expect(node.textContent).toContain('Save outcome is unknown');
  expect(button('Edit Context byte ceiling').closest('fieldset')?.disabled).toBe(true);
  const saved = sent()[1]!.body;
  vi.mocked(runtimeFetch).mockResolvedValueOnce(json({ installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    operation_id: saved.operation_id, persistence: 'saved', persisted_revision: 'c'.repeat(64), before_revision: view.source_revision,
    application: 'not_applied', replayed: true }));
  await click('Check save outcome'); expect(node.textContent).toContain('User defaults saved'); expect(sent()).toHaveLength(2);
});

it('invalidates a preview after an edit and does not submit empty, fractional or out-of-bounds integers', async () => {
  await mount(); await click('Edit Context byte ceiling'); await click('Preview change'); expect(node.textContent).toContain('Save to NNA');
  for (const invalid of ['', '65535', '65536.5', '16777217']) { await input('Context byte ceiling', invalid);
    expect(button('Preview change').disabled).toBe(true); expect(node.textContent).not.toContain('Save to NNA'); }
  expect(sent()).toHaveLength(1);
});

it('supports explicit reset and recovery action ordering without a JSON editor', async () => {
  await mount(); await click('Edit Maximum model steps'); await act(async () => (node.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await click('Preview change'); expect(sent()[0]?.body.operations).toEqual([{ op: 'reset', field: 'recovery.max_model_steps' }]);
  expect(button('Save to NNA').disabled).toBe(false); expect(node.querySelector('[role="alert"]')).toBeNull();
  await click('Edit Recovery actions'); await click('Move down'); await click('Remove step'); await click('Add nudge');
  await click('Preview change'); expect(sent()[1]?.body.operations).toEqual([{ op: 'set', field: 'recovery.ladder', value: ['nudge', 'compact', 'compact', 'nudge'] }]);
});

it('discards late preview responses after a runtime switch and pauses changes during authority recovery', async () => {
  await mount(); await click('Edit Maximum model steps'); let finish!: (value: Response) => void;
  vi.mocked(runtimeFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click('Preview change'); runtime.origin = 'http://127.0.0.1:4000';
  await act(async () => finish(json({ valid: true, expected_revision: view.source_revision, resolution_revision: view.resolution_revision, application: 'not_applied', view })));
  expect(node.textContent).not.toContain('Save to NNA');
  await act(async () => { beginAuthorityRecovery('local'); }); expect(node.textContent).toContain('paused until native authority');
  expect(button('Edit Maximum model steps').closest('fieldset')?.disabled).toBe(true);
});
