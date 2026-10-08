// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { primaryNndWorkspaceBinding } from './nnd-workspace-binding.js';

const WORKSPACE_ID = /^ws_[a-f0-9]{24}$/u;
const mismatch = () => new ContractError('nnd_workspace_binding_invalid',
  'Selected NND workspace is no longer admitted or has changed on disk.');

/** Resolve a selected identity from native storage on every use, including
 * restore and tool execution. A browser directory never becomes authority. */
export function createNndWorkspaceBindingResolver(primaryRoot, admissionService) {
  const reader = { subjectId: 'nnd-local-operator', permissions: ['nnd.workspace.read'] };
  return async (selectedId) => {
    const primary = await primaryNndWorkspaceBinding(primaryRoot);
    if (selectedId === undefined || selectedId === primary.id) return primary;
    if (!WORKSPACE_ID.test(selectedId ?? '') || !admissionService) throw mismatch();
    const inventory = await admissionService.inventory(reader);
    if (inventory.attached?.id !== primary.id || inventory.attached.root !== primary.root) throw mismatch();
    const row = inventory.admitted.find(value => value.id === selectedId);
    if (!row) throw mismatch();
    return Object.freeze({ root: row.root, configured_root: row.root, id: row.id,
      device: row.device, inode: row.inode });
  };
}
