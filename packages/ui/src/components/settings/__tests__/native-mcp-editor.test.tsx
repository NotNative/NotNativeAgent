// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const runtime = vi.hoisted(() => ({ key: 'native-runtime', listeners: new Set<() => void>() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => runtime.key,
  isTransientRuntimeKey: () => false,
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listeners.add(listener);
    return () => runtime.listeners.delete(listener); },
}));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { NativeMcpEditor } from '../pages/native-mcp-editor.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fetchMock = runtimeFetch as unknown as Mock;
const revision = 'a'.repeat(64), resolution = 'b'.repeat(64), savedRevision = 'c'.repeat(64);
const view = { schema_version: '1.0', installation_id: 'install_mcp', data_id: 'data_mcp', scope: 'user',
  source_state: 'present', source_revision: revision, resolution_revision: resolution, project_shadowed: false,
  application: 'not_applied', servers: [] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json' } });
let container: HTMLDivElement;
let root: Root;

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
async function renderEditor(): Promise<void> {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => { root.render(<NativeMcpEditor />); }); await settle();
}
async function enter(label: string, value: string): Promise<void> {
  const input = [...container.querySelectorAll<HTMLInputElement>('input')].find(item =>
    item.closest('label')?.textContent?.startsWith(label));
  if (!input) throw new Error(`missing input ${label}`);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  if (!button) throw new Error(`missing button ${label}`);
  await act(async () => { button.click(); }); await settle();
}
const receipt = (operationId: string) => ({ installation_id: view.installation_id, data_id: view.data_id,
  scope: 'user', operation_id: operationId, persistence: 'saved', persisted_revision: savedRevision,
  before_revision: revision, application: 'not_applied', replayed: false });

beforeEach(() => {
  runtime.key = 'native-runtime'; sessionStorage.clear(); useAuthSessionStore.getState().markOk(); fetchMock.mockReset();
});
afterEach(() => { if (root) act(() => root.unmount()); container?.remove(); });

describe('native MCP editor', () => {
  it('requires delete confirmation to remain checked through save', async () => {
    const existing = { ...view, servers: [{ id: 'alpha', transport: 'stdio', enabled: false, trusted: false }] };
    fetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/configuration/mcp')) return Promise.resolve(json(existing));
      if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
        resolution_revision: resolution, application: 'not_applied', change: { op: 'delete', id: 'alpha' }, view }));
      if (path.endsWith('/save')) throw new Error('delete sent after confirmation withdrawn');
      throw new Error(`unexpected ${path}`);
    });
    await renderEditor();
    const action = [...container.querySelectorAll<HTMLSelectElement>('select')].find(item =>
      item.closest('label')?.textContent?.startsWith('Action'))!;
    await act(async () => { action.value = 'delete'; action.dispatchEvent(new Event('change', { bubbles: true })); });
    const confirmation = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => { confirmation.click(); });
    await click('Preview native change');
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item =>
      item.textContent?.trim() === 'Save with native revision check')!;
    expect(save.disabled).toBe(false);
    await act(async () => { confirmation.click(); });
    expect(save.disabled).toBe(true);
    await act(async () => { save.click(); });
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/save'))).toBe(false);
  });

  it('previews and saves a disabled local server with exact native CAS, then reports not applied', async () => {
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      if (path.endsWith('/configuration/mcp')) return Promise.resolve(json(view));
      const body = JSON.parse(String(init.body));
      if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
        resolution_revision: resolution, application: 'not_applied', change: { op: 'create', id: 'alpha' },
        view: { ...view, servers: [{ id: 'alpha', transport: 'stdio', enabled: false, trusted: false }] } }));
      if (path.endsWith('/save')) return Promise.resolve(json(receipt(body.operation_id)));
      throw new Error(`unexpected ${path}`);
    });
    await renderEditor(); await enter('Server ID', 'alpha'); await enter('Command', 'mcp-server');
    await click('Preview native change');
    const previewCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/preview'))!;
    expect(JSON.parse(String(previewCall[1].body))).toEqual({ installation_id: view.installation_id,
      data_id: view.data_id, scope: 'user', expected_revision: revision, expected_resolution_revision: resolution,
      change: { op: 'create', id: 'alpha', fields: { transport: 'stdio', command: 'mcp-server', args: [] } } });
    await click('Save with native revision check');
    const saveCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/save'))!;
    const savedBody = JSON.parse(String(saveCall[1].body));
    expect(savedBody.operation_id).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(savedBody.expected_revision).toBe(revision);
    expect(container.textContent).toContain('Saved to NNA’s manifest; not applied to current sessions.');
    expect(sessionStorage.getItem('nnd.mcp.pending.v1')).not.toContain(savedBody.operation_id);
  });

  it('retains an uncertain operation for native receipt inspection', async () => {
    let operationId = '';
    fetchMock.mockImplementation((path: string, init: RequestInit) => {
      if (path.endsWith('/configuration/mcp')) return Promise.resolve(json(view));
      if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
        resolution_revision: resolution, application: 'not_applied', change: { op: 'create', id: 'alpha' }, view }));
      if (path.endsWith('/save')) { operationId = JSON.parse(String(init.body)).operation_id;
        return Promise.resolve(json({ error: { code: 'manifest_publication_unknown' } }, 503)); }
      if (path.endsWith(`/operations/${operationId}`)) return Promise.resolve(json(receipt(operationId)));
      throw new Error(`unexpected ${path}`);
    });
    await renderEditor(); await enter('Server ID', 'alpha'); await enter('Command', 'mcp-server');
    await click('Preview native change'); await click('Save with native revision check');
    expect(sessionStorage.getItem('nnd.mcp.pending.v1')).toContain(operationId);
    expect(container.textContent).toContain('may have an uncertain outcome');
    await click('Inspect operation');
    expect(container.textContent).toContain('Saved to NNA’s manifest; not applied to current sessions.');
    expect(sessionStorage.getItem('nnd.mcp.pending.v1')).not.toContain(operationId);
  });

  it('clears a rejected stale CAS reservation so the operator can refresh', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path.endsWith('/configuration/mcp')) return Promise.resolve(json(view));
      if (path.endsWith('/preview')) return Promise.resolve(json({ valid: true, expected_revision: revision,
        resolution_revision: resolution, application: 'not_applied', change: { op: 'create', id: 'alpha' }, view }));
      if (path.endsWith('/save')) return Promise.resolve(json({ error: { code: 'manifest_revision_conflict' } }, 409));
      throw new Error(`unexpected ${path}`);
    });
    await renderEditor(); await enter('Server ID', 'alpha'); await enter('Command', 'mcp-server');
    await click('Preview native change'); await click('Save with native revision check');
    expect(container.textContent).toContain('Configuration changed. Refresh and preview again.');
    expect(container.textContent).not.toContain('may have an uncertain outcome');
    expect(sessionStorage.getItem('nnd.mcp.pending.v1')).toBe('[]');
  });
});
