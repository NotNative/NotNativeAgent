// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../stores/useWorkspaceStore.ts';
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { useWorkspaceDisplayStore } from '../stores/useWorkspaceDisplayStore.ts';
import { useGlobalSessionsStore } from '../sync/global-stores.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { readLastActiveSession } from '../sync/persist-cache.ts';
import { addNativeWorkspace } from '../lib/nnd/workspace-admission.ts';

/** First use gets a real user-data folder; existing conversations and workspace choices take precedence. */
export function useInitialConversation(enabled: boolean, runtime: string, open: (directory: string, draftId?: string) => void): string | null {
  const view = useSessionViewStore();
  const inventory = useWorkspaceStore(state => state.inventory);
  const sessions = useGlobalSessionsStore();
  const drafts = useConversationDraftStore(state => state.drafts);
  const phase = useConversationDraftStore(state => state.phase);
  const syncError = useConversationDraftStore(state => state.syncError);
  const draftError = useConversationDraftStore(state => state.error);
  const attempted = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (phase === 'loading' || phase === 'error' || draftError || !enabled || !inventory || sessions.status !== 'ready' || attempted.current === runtime) return;
    const before = view;
    if (!before.activeDirectory || before.activeDirectory === 'global' || before.currentSessionId || before.currentDraftId) return;
    const pointer = readLastActiveSession();
    if (pointer && sessions.active.some(session => session.id === pointer.sessionId)) return;
    attempted.current = runtime; setError(null);
    if (drafts.length) { const latest = drafts.at(-1)!; open(latest.directory, latest.id); return; }
    if (sessions.active.length || sessions.archived.length || inventory.admitted.length) { open(before.activeDirectory); return; }
    const initialize = async () => {
      const response = await runtimeFetch('/api/workspace-default', { method: 'POST' });
      const data = await response.json();
      if (!response.ok || typeof data.directory !== 'string') throw new Error('Could not prepare the default workspace. Add a workspace to continue.');
      if (getRuntimeKey() !== runtime) return;
      const selected = await addNativeWorkspace(data.directory);
      if (getRuntimeKey() !== runtime) return;
      useWorkspaceStore.getState().adopt(selected.inventory);
      const row = [selected.inventory.attached, ...selected.inventory.admitted].find(value => value.root === selected.directory);
      if (row) await useWorkspaceDisplayStore.getState().save(row.id, { label: 'Default workspace', hidden: false });
      const current = useSessionViewStore.getState();
      if (current.currentSessionId === null && current.currentDraftId === null && current.activeDirectory === before.activeDirectory) open(selected.directory);
    };
    void initialize().catch(failure => { if (getRuntimeKey() === runtime) setError(String(failure)); });
  }, [enabled, runtime, inventory, sessions.status, sessions.active.length, sessions.archived.length, drafts.length, draftError, phase, open, view.activeDirectory, view.currentSessionId, view.currentDraftId]);
  return error ?? draftError ?? syncError;
}
