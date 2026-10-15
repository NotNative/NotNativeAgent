// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { newConversationWorkspace } from '../active-workspaces.ts';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore.ts';
import { useWorkspaceDisplayStore } from '../../stores/useWorkspaceDisplayStore.ts';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { addNativeWorkspace, type WorkspaceAdmissions } from '../../lib/nnd/workspace-admission.ts';
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('../../lib/nnd/workspace-admission.ts', () => ({ addNativeWorkspace: vi.fn(), readNativeWorkspaceAdmissions: vi.fn() }));
const inventory: WorkspaceAdmissions = { installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
  attached: { id: 'ws_a', root: 'D:/hidden' }, admitted: [{ id: 'ws_b', root: 'D:/active', operation_id: 'prior' }], unavailable: [] };
beforeEach(() => {
  vi.resetAllMocks(); useWorkspaceStore.getState().adopt(inventory);
  useWorkspaceDisplayStore.setState({ rows: { ws_a: { label: '', hidden: true } }, ready: true, error: null });
  vi.spyOn(useWorkspaceDisplayStore.getState(), 'load').mockResolvedValue();
});
afterEach(() => vi.restoreAllMocks());
it('selects active roots without reviving a hidden current root', async () => {
  expect(await newConversationWorkspace('D:/hidden')).toBe('D:/active');
  expect(await newConversationWorkspace('d:/ACTIVE')).toBe('D:/active');
  expect(runtimeFetch).not.toHaveBeenCalled();
});
it('prepares and admits one default folder when every workspace is hidden', async () => {
  useWorkspaceDisplayStore.setState({ rows: { ws_a: { label: '', hidden: true }, ws_b: { label: '', hidden: true } } });
  vi.mocked(runtimeFetch).mockResolvedValue(Response.json({ directory: 'D:/home/.nna/workspace' }));
  vi.mocked(addNativeWorkspace).mockResolvedValue({ directory: 'D:/home/.nna/workspace', added: true,
    inventory: { ...inventory, admitted: [...inventory.admitted, { id: 'ws_c', root: 'D:/home/.nna/workspace', operation_id: 'default' }] } });
  const save = vi.spyOn(useWorkspaceDisplayStore.getState(), 'save').mockResolvedValue();
  expect(await Promise.all([newConversationWorkspace('D:/hidden'), newConversationWorkspace('D:/hidden')]))
    .toEqual(['D:/home/.nna/workspace', 'D:/home/.nna/workspace']);
  expect(addNativeWorkspace).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('ws_c', { label: 'Default workspace', hidden: false });
});
it('fails visibly rather than using hidden roots when visibility cannot be read', async () => {
  useWorkspaceDisplayStore.setState({ ready: false, error: 'offline' });
  await expect(newConversationWorkspace('D:/hidden')).rejects.toThrow('Could not load active workspaces');
  expect(addNativeWorkspace).not.toHaveBeenCalled();
});
