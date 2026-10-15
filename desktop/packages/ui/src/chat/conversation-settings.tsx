// SPDX-License-Identifier: Apache-2.0
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { readDraft } from './drafts.ts';
import { toast } from 'sonner';
import { ConfiguredModelPicker, type ConversationModel } from './configured-model-picker.tsx';

export function ConversationSettings({ directory, draftId, model, onModel }: {
  directory: string; draftId: string; model: ConversationModel; onModel: (model: ConversationModel) => void;
}) {
  const draft = useConversationDraftStore(state => state.drafts.find(row => row.id === draftId));
  const selected = draft?.model ?? model;
  const locked = Boolean(readDraft(directory, draftId).start);
  const change = (value: ConversationModel) => {
    try { if (draft) useConversationDraftStore.getState().update(draft.id, { model: value }); onModel(value); }
    catch (failure) { toast.error(String(failure)); }
  };
  return <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-neutral-300" data-testid="conversation-settings">
    {draft ? <select aria-label="Review policy" disabled={locked} value={draft.reviewMode} className="cursor-pointer rounded-md bg-transparent py-1.5 pr-2 hover:bg-white/5 [&>option]:bg-neutral-900" onChange={event => {
      try { useConversationDraftStore.getState().update(draft.id, { reviewMode: event.target.value as 'auto-review' | 'unattended' }); } catch (failure) { toast.error(String(failure)); }
    }}><option value="auto-review">Auto-review</option><option value="unattended">Unattended review</option></select> : <span>Auto-review</span>}
    <ConfiguredModelPicker selected={selected} disabled={locked} onPick={change} />
  </div>;
}
