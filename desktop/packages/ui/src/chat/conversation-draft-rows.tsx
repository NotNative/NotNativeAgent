// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { useConversationDraftStore, rememberConversationDraft } from '../stores/useConversationDraftStore.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { dropDraft, readDraft, subscribeDraftChanges, getDraftRevision } from './drafts.ts';
import { toast } from 'sonner';
import { visibleConversationDrafts } from './visible-conversation-drafts.ts';

export function ConversationDraftRows({ directory, onOpen }: { directory?: string; onOpen: (directory: string, id?: string) => void }) {
  useSyncExternalStore(subscribeDraftChanges, getDraftRevision);
  const drafts = useConversationDraftStore(state => state.drafts);
  const active = useSessionViewStore(state => state.currentSessionId === null ? state.currentDraftId : null);
  return <>{visibleConversationDrafts(drafts, active).filter(draft => directory === undefined || normalizeDirectory(draft.directory) === normalizeDirectory(directory)).map(draft =>
    <li key={draft.id} className={`mb-1 flex items-center rounded-md ${active === draft.id ? 'bg-white/10' : 'hover:bg-white/5'}`}>
      <button type="button" className="min-w-0 flex-1 px-3 py-2 text-left text-[13px]" aria-current={active === draft.id ? 'page' : undefined}
        onClick={() => onOpen(draft.directory, draft.id)}><span className="block truncate">{(draft.title === 'New conversation' ? readDraft(draft.directory, draft.id).text.trim().split('\n')[0]?.slice(0, 80) || draft.title : draft.title)}</span><span className="text-[11px] text-neutral-500">Draft</span></button>
      <button type="button" aria-label={`Discard draft ${draft.title}`} title="Discard draft" className="h-8 w-8 text-neutral-500 hover:text-neutral-200" onClick={async () => {
        const content = readDraft(draft.directory, draft.id);
        if ((content.text || content.attachments.length) && !confirm('Discard this draft and its attachments?')) return;
        try {
          await useConversationDraftStore.getState().remove(draft.id); dropDraft(draft.directory, draft.id);
          if (active === draft.id) { useSessionViewStore.setState({ currentDraftId: null }); rememberConversationDraft(null); }
        } catch (error) { toast.error(String(error)); }
      }}>×</button>
    </li>)}</>;
}
