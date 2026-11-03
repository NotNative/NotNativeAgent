// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addNativeWorkspace, type WorkspaceAdmissions } from '../../lib/nnd/workspace-admission.ts';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore.ts';
import { ensureWorkspaceAdmitted, inventoryAdmits } from '../workspace-admit.ts';

vi.mock('../../lib/nnd/workspace-admission.ts', () => ({
  addNativeWorkspace: vi.fn(),
  readNativeWorkspaceAdmissions: vi.fn(),
}));

function inventory(roots: string[]): WorkspaceAdmissions {
  return {
    installation_id: 'nna_a', data_id: 'data_b', revision: 'absent', selection_enabled: true,
    attached: { root: roots[0]!, id: 'ws_000000000000000000000000' },
    admitted: roots.slice(1).map((root, index) => ({ root, id: `ws_${String(index + 1).padStart(24, '0')}`, operation_id: `op${index}` })),
    unavailable: [],
  };
}

describe('workspace admission for operator surfaces', () => {
  beforeEach(() => {
    vi.mocked(addNativeWorkspace).mockReset();
    useWorkspaceStore.getState().reset();
  });

  it('recognizes an admitted folder across Windows spellings', () => {
    expect(inventoryAdmits(inventory(['D:/Work/Project']), 'd:\\work\\project\\')).toBe(true);
    expect(inventoryAdmits(inventory(['D:/Work/Project']), 'D:/Work/Other')).toBe(false);
    expect(inventoryAdmits(null, 'D:/Work/Project')).toBe(false);
  });

  it('does not ask NNA again for a folder it already admitted', async () => {
    useWorkspaceStore.getState().adopt(inventory(['D:/Work/Project']));
    expect(await ensureWorkspaceAdmitted('D:/Work/Project')).toBe(true);
    expect(addNativeWorkspace).not.toHaveBeenCalled();
  });

  it('asks NNA once for a folder it has not admitted and adopts the receipt', async () => {
    vi.mocked(addNativeWorkspace).mockResolvedValue({ directory: 'D:/Work/Project', added: true,
      inventory: inventory(['D:/Work/Other', 'D:/Work/Project']) });
    expect(await ensureWorkspaceAdmitted('D:\\Work\\Project')).toBe(true);
    expect(addNativeWorkspace).toHaveBeenCalledWith('D:\\Work\\Project');
    expect(useWorkspaceStore.getState().inventory?.admitted).toHaveLength(1);
  });

  it('asks when the inventory is loaded and does not admit a folder it already lists', async () => {
    vi.mocked(addNativeWorkspace).mockResolvedValue({ directory: 'D:/Work/Project', added: false,
      inventory: inventory(['D:/Work/Project']) });
    // An unloaded inventory cannot prove refusal, so the call still goes out
    // and NNA, not this client, decides that nothing needs to change.
    expect(useWorkspaceStore.getState().phase).toBe('idle');
    expect(await ensureWorkspaceAdmitted('D:/Work/Project')).toBe(true);
    expect(addNativeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('reports failure rather than claiming an admission it did not get', async () => {
    vi.mocked(addNativeWorkspace).mockRejectedValue(new Error('NNA did not admit this workspace.'));
    expect(await ensureWorkspaceAdmitted('D:/Work/Project')).toBe(false);
  });

  it('treats an empty directory as nothing to admit', async () => {
    expect(await ensureWorkspaceAdmitted('   ')).toBe(false);
    expect(addNativeWorkspace).not.toHaveBeenCalled();
  });
});
