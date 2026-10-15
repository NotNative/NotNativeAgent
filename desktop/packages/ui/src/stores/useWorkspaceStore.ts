// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { readNativeWorkspaceAdmissions, type WorkspaceAdmissions } from '../lib/nnd/workspace-admission.ts';

interface WorkspaceState {
  inventory: WorkspaceAdmissions | null;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  load: (refresh?: boolean) => Promise<void>;
  adopt: (inventory: WorkspaceAdmissions) => void;
  reset: () => void;
}

let generation = 0;
let pending: Promise<void> | null = null;

/** One projection of native workspace authority for the sidebar and composer. */
export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  inventory: null, phase: 'idle', error: null,
  load: (refresh = false) => {
    if (pending) return pending;
    if (!refresh && get().phase === 'ready') return Promise.resolve();
    const runtime = getRuntimeKey(), read = ++generation;
    set({ phase: 'loading', error: null });
    const attempt = readNativeWorkspaceAdmissions().then(inventory => {
      if (read === generation && runtime === getRuntimeKey()) set({ inventory, phase: 'ready', error: null });
    }).catch(error => {
      if (read === generation && runtime === getRuntimeKey()) set({ phase: 'error',
        error: error instanceof Error ? error.message : 'Workspace list unavailable.' });
    }).finally(() => { if (pending === attempt) pending = null; });
    pending = attempt;
    return attempt;
  },
  adopt: inventory => {
    generation += 1;
    pending = null;
    set({ inventory, phase: 'ready', error: null });
  },
  reset: () => {
    generation += 1;
    pending = null;
    set({ inventory: null, phase: 'idle', error: null });
  },
}));

onRuntimeEndpointChanged(() => useWorkspaceStore.getState().reset());
