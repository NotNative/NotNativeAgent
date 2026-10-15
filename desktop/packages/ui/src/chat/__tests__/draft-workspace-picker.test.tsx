import { useWorkspaceStore } from '../../stores/useWorkspaceStore.ts';
// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DraftWorkspacePicker } from '../draft-workspace-picker.tsx';
import { readNativeWorkspaceAdmissions } from '../../lib/nnd/workspace-admission.ts';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';

vi.mock('../../lib/nnd/workspace-admission.ts', () => ({ readNativeWorkspaceAdmissions: vi.fn() }));
import { useWorkspaceDisplayStore } from '../../stores/useWorkspaceDisplayStore.ts';
beforeEach(() => { useWorkspaceDisplayStore.setState({ rows: {}, ready: true, error: null }); vi.spyOn(useWorkspaceDisplayStore.getState(), 'load').mockResolvedValue(); });

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; vi.restoreAllMocks(); useWorkspaceStore.getState().reset(); });

function mount(onSelect = vi.fn()): HTMLDivElement {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<DraftWorkspacePicker directory="D:/work" onSelect={onSelect} />));
  return container;
}

it('selects an admitted workspace for a new conversation', async () => {
  vi.mocked(readNativeWorkspaceAdmissions).mockResolvedValue({ installation_id: 'install', data_id: 'data',
    revision: 'absent', selection_enabled: true, attached: { root: 'D:/work', id: 'ws_a' },
    admitted: [{ root: 'D:/other', id: 'ws_b', operation_id: 'prior' }], unavailable: [] });
  const onSelect = vi.fn();
  const node = mount(onSelect);
  await act(async () => { await Promise.resolve(); });
  const select = node.querySelector<HTMLSelectElement>('[aria-label="New conversation workspace"]')!;
  expect([...select.options].map(option => option.value)).toEqual(['D:/work', 'D:/other']);
  act(() => { select.value = 'D:/other'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(onSelect).toHaveBeenCalledWith('D:/other');
});

it('does not offer an unknown workspace when inventory is unavailable', async () => {
  vi.mocked(readNativeWorkspaceAdmissions).mockRejectedValue(new Error('offline'));
  const node = mount();
  await act(async () => { await Promise.resolve(); });
  expect(node.querySelector('[role="status"]')?.textContent).toContain('unavailable');
  expect(node.querySelector<HTMLSelectElement>('select')?.disabled).toBe(true);
});

it('excludes hidden workspaces from the selector', async () => {
  vi.mocked(readNativeWorkspaceAdmissions).mockResolvedValue({ installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
    attached: { root: 'D:/work', id: 'ws_a' }, admitted: [{ root: 'D:/hidden', id: 'ws_b', operation_id: 'prior' }], unavailable: [] });
  useWorkspaceDisplayStore.setState({ rows: { ws_b: { label: 'Hidden', hidden: true } } });
  const node = mount();
  await act(async () => { await Promise.resolve(); });
  expect([...node.querySelector('select')!.options].map(option => option.value)).toEqual(['D:/work']);
});
