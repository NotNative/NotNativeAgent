// SPDX-License-Identifier: Apache-2.0
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { flushConversationDraftPersistence } from './conversation-draft-persistence.ts';
export function DraftPersistenceStatus() {
  const phase = useConversationDraftStore(state => state.phase), error = useConversationDraftStore(state => state.syncError);
  const saving = useConversationDraftStore(state => state.saving), count = useConversationDraftStore(state => state.drafts.length);
  if (phase === 'loading') return <p role="status" className="mb-2 text-xs text-neutral-400">Restoring conversation drafts…</p>;
  if (!error) return phase === 'ready' && count > 0 ? <p role="status" className="mb-2 text-[11px] text-neutral-500">{saving ? 'Saving drafts…' : 'Drafts saved'}</p> : null;
  return <div role="alert" className="mb-2 text-xs text-amber-300">Drafts are not saved to the service. {error}
    <button type="button" className="ml-1 underline" onClick={() => { if (phase === 'error') void useConversationDraftStore.getState().connect(); else void flushConversationDraftPersistence().catch(() => undefined); }}>Retry draft save</button>
  </div>;
}
