// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace admission for read-only operator surfaces.
 *
 * Why: NNA authorizes every fs/git read against the workspace it admitted. A
 * folder the operator opened in the rail but NNA never admitted answers 409
 * "This workspace is not admitted by NNA", which reads as a broken panel
 * rather than as a missing grant. The rail admits the folder it is showing
 * before drawing a surface that reads it, so the panel opens instead of
 * failing.
 *
 * This is not authority of its own: NNA decides, the receipt is checked by
 * `addNativeWorkspace`, and nothing here invents an admission.
 */
import { addNativeWorkspace, type WorkspaceAdmissions } from '../lib/nnd/workspace-admission.ts';
import { useWorkspaceStore } from '../stores/useWorkspaceStore.ts';

function normalized(value: string): string {
  const slashed = value.replaceAll('\\', '/').replace(/\/+$/u, '');
  return /^[A-Za-z]:\//u.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** Whether this inventory already lets NNA read the folder. */
export function inventoryAdmits(inventory: WorkspaceAdmissions | null, directory: string): boolean {
  if (!inventory) return false;
  const target = normalized(directory);
  return [inventory.attached, ...inventory.admitted].some((row) => normalized(row.root) === target);
}

/**
 * Ask NNA to admit `directory` if it does not already. Resolves to whether the
 * folder is admitted afterwards, so a caller can say why a panel is empty.
 */
export async function ensureWorkspaceAdmitted(directory: string): Promise<boolean> {
  if (directory.trim() === '') return false;
  const known = useWorkspaceStore.getState().inventory;
  if (inventoryAdmits(known, directory)) return true;
  try {
    const selected = await addNativeWorkspace(directory.trim());
    useWorkspaceStore.getState().adopt(selected.inventory);
    return inventoryAdmits(selected.inventory, selected.directory);
  } catch {
    // An unreadable inventory is not proof of refusal, but the surface still
    // needs a definite answer before it reads. Keep the caller's message.
    return false;
  }
}
