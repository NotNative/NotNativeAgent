// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { readNativeWorkspaceAdmissions, removeUnavailableNativeWorkspace } from '../lib/nnd/workspace-admission.ts';

/** Explicit cleanup for directories NNA can no longer verify. The native
 * session host still owns the final refusal for live or quarantined sessions. */
export function WorkspaceRecoveryControls({ runtimeKey, refreshKey }: {
  runtimeKey: string; refreshKey: number;
}): ReactNode {
  const [roots, setRoots] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setRoots([]);
    void readNativeWorkspaceAdmissions().then(inventory => {
      if (live) setRoots(inventory.unavailable.map(row => row.root));
    }).catch(() => { if (live) setRoots([]); });
    return () => { live = false; };
  }, [runtimeKey, refreshKey]);
  const remove = async (root: string): Promise<void> => {
    try {
      await removeUnavailableNativeWorkspace(root);
      setRoots((await readNativeWorkspaceAdmissions()).unavailable.map(row => row.root));
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Could not remove the unavailable workspace.'); }
  };
  return roots.map(root => <div key={root} className="mb-2 rounded border border-amber-500/30 p-2 text-[11px] text-amber-200">
    <div>Unavailable workspace: {root}</div>
    <button type="button" className="mt-1 underline" onClick={() => void remove(root)}>Remove stale admission</button>
  </div>);
}
