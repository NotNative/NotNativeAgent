// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { getRuntimeKey, isTransientRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { readDraft, saveDraft, dropDraft, flushDraftsNow } from '../chat/drafts.ts';

export type ConversationDraft = {
  id: string; directory: string; createdAt: number; title: string;
  model: { providerID: string; modelID: string } | null;
  reviewMode: 'auto-review' | 'unattended';
};
interface State {
  drafts: ConversationDraft[];
  error: string | null;
  load: () => void;
  create: (directory: string) => ConversationDraft;
  update: (id: string, patch: Partial<Pick<ConversationDraft, 'title' | 'model' | 'reviewMode'>>) => void;
  move: (id: string, directory: string) => void;
  remove: (id: string) => void;
}
const key = () => `nnd.conversation-drafts.v1:${getRuntimeKey()}`;
function read(): ConversationDraft[] {
  if (isTransientRuntimeKey(getRuntimeKey())) return [];
    const data: unknown = JSON.parse(localStorage.getItem(key()) ?? '[]');
    if (!Array.isArray(data) || data.length > 64) throw new Error('Conversation drafts could not be read.');
    const valid = data.every(row => row && typeof row === 'object'
      && /^draft_[a-f0-9-]{36}$/u.test(row.id) && typeof row.directory === 'string'
      && row.directory.length <= 4096 && typeof row.title === 'string' && row.title.length <= 120
      && Number.isFinite(row.createdAt) && ['auto-review', 'unattended'].includes(row.reviewMode)
      && (row.model === null || typeof row.model?.providerID === 'string' && typeof row.model?.modelID === 'string'));
    if (!valid) throw new Error('Conversation drafts are invalid. Their stored data was preserved.');
    return data;
}
function persist(drafts: ConversationDraft[]): void {
  if (isTransientRuntimeKey(getRuntimeKey())) throw new Error('Wait for the connection before creating a conversation.');
  const error = useConversationDraftStore.getState().error; if (error) throw new Error(error);
  // Invariant: do not report a durable draft when browser storage rejected it.
  try { localStorage.setItem(key(), JSON.stringify(drafts)); }
  catch { throw new Error('Could not save the draft. Free browser storage and retry.'); }
}
export const useConversationDraftStore = create<State>((set, get) => ({
  drafts: [], error: null,
  load: () => { try { set({ drafts: read(), error: null }); } catch (error) { set({ error: String(error) }); } },
  create: directory => {
    if (get().error) throw new Error(get().error!);
    if (get().drafts.length >= 64) throw new Error('Finish or discard a draft before creating another conversation.');
    const draft: ConversationDraft = { id: `draft_${crypto.randomUUID()}`, directory: normalizeDirectory(directory),
      createdAt: Date.now(), title: 'New conversation', model: null, reviewMode: 'auto-review' };
    const drafts = [...get().drafts, draft]; persist(drafts); set({ drafts }); return draft;
  },
  update: (id, patch) => {
    const drafts = get().drafts.map(draft => draft.id === id ? { ...draft, ...patch } : draft);
    persist(drafts); set({ drafts });
  },
  move: (id, directory) => {
    const draft = get().drafts.find(row => row.id === id); if (!draft) return;
    const next = normalizeDirectory(directory); if (next === draft.directory) return;
    saveDraft(next, id, readDraft(draft.directory, id)); flushDraftsNow();
    const drafts = get().drafts.map(row => row.id === id ? { ...row, directory: next } : row);
    persist(drafts); set({ drafts }); dropDraft(draft.directory, id);
  },
  remove: id => { const drafts = get().drafts.filter(draft => draft.id !== id); persist(drafts); set({ drafts }); },
}));
onRuntimeEndpointChanged(() => { useConversationDraftStore.setState({ drafts: [], error: null }); useConversationDraftStore.getState().load(); });

export function rememberConversationDraft(id: string | null): void {
  if (id === null) localStorage.removeItem(`${key()}:selected`);
  else localStorage.setItem(`${key()}:selected`, id);
}

export function selectedConversationDraft(): ConversationDraft | undefined {
  const id = localStorage.getItem(`${key()}:selected`);
  return useConversationDraftStore.getState().drafts.find(draft => draft.id === id);
}
