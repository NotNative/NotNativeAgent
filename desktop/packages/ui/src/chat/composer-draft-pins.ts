// SPDX-License-Identifier: Apache-2.0
/** Draft-only project pin handoff at first material delivery. */
import { useSessionViewStore } from '../sync/view-store.ts';
import { readDraft, saveDraft, saveConversationStart, dropDraft, type ConversationStart } from './drafts.ts';
import { parseProjectContextPins, type ProjectContextPinTargets } from './project-context-pins.ts';
import { ascendingId, harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import { useConversationDraftStore, rememberConversationDraft } from '../stores/useConversationDraftStore.ts';
import { persistLastActiveSession } from '../sync/persist-cache.ts';
import { toast } from 'sonner';
import { modelForCreatedSession } from './composer-model-config.ts';

type NewSessionLike = { id: string; metadata?: Record<string, unknown> };

export interface NewSessionDeliveryInput {
  directory: string;
  sourceKey: string;
  outgoing: ({ type: 'text'; text: string; synthetic?: boolean } |
    { type: 'file'; url?: string; filename?: string; mime?: string })[];
  delivery: 'steer' | null;
  model: { providerID: string; modelID: string };
  sendAgent: string;
  nnaConfigured: boolean;
  services: { engine: { actions: {
    send: (input: { directory: string; sessionID: string; messageID?: string; parts: NewSessionDeliveryInput['outgoing'];
      model: { providerID: string; modelID: string }; agent?: string; delivery?: 'steer' }) => Promise<void>;
    createSession: (input: { directory: string; title?: string; projectContextPins?: ProjectContextPinTargets; select?: boolean;
      model?: { providerID: string; modelID: string }; reviewMode?: 'auto-review' | 'unattended'; operationId?: string; startFingerprint?: string }) => Promise<NewSessionLike>;
  } } };
}

async function startFor(input: NewSessionDeliveryInput): Promise<ConversationStart> {
  const stored = readDraft(input.directory, input.sourceKey).start;
  if (stored) return stored;
  const draft = useConversationDraftStore.getState().drafts.find(row => row.id === input.sourceKey);
  const firstText = input.outgoing.find(part => part.type === 'text' && !part.synthetic);
  const title = firstText?.type === 'text' ? firstText.text.split('\n')[0]!.trim().slice(0, 80) : 'New conversation';
  const messageID = draft ? `msg_${(draft.createdAt * 4096).toString(36).padStart(11, '0')}_${draft.id.slice(6).replaceAll('-', '').slice(0, 14)}` : ascendingId('msg');
  const bytes = new TextEncoder().encode(JSON.stringify(input.outgoing));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const start: ConversationStart = { operationId: draft?.id ?? crypto.randomUUID(), messageID, fingerprint,
    title: draft && draft.title !== 'New conversation' ? draft.title : title || 'New conversation',
    model: draft?.model ?? input.model, reviewMode: draft?.reviewMode ?? 'auto-review', parts: input.outgoing };
  saveConversationStart(input.directory, input.sourceKey, start);
  return start;
}

async function materialize(input: NewSessionDeliveryInput, start: ConversationStart): Promise<ConversationStart> {
  if (start.sessionID) {
    const response = await harnessClient.getSession(start.sessionID, { directory: input.directory });
    if (response.error || !response.data || normalizeDirectory(response.data.directory) !== normalizeDirectory(input.directory)) {
      throw new Error('The created conversation is unavailable in this workspace. Refresh before retrying.');
    }
    const model = modelForCreatedSession(response.data.metadata, input.nnaConfigured, start.model);
    if (model.providerID !== start.model.providerID || model.modelID !== start.model.modelID) throw new Error('The conversation model changed. Refresh before retrying.');
    return start;
  }
  const targets = normalizeDraftProjectContextPins(readDraft(input.directory, input.sourceKey).projectContextPins);
  let created;
  try {
    created = await input.services.engine.actions.createSession({ directory: input.directory, title: start.title, select: false,
      ...(input.nnaConfigured ? { model: start.model, reviewMode: start.reviewMode, operationId: start.operationId, startFingerprint: start.fingerprint } : {}),
      ...(targets.notes.length || targets.plans.length ? { projectContextPins: targets } : {}) });
  } catch (error) {
    if ((error as { creationNotApplied?: boolean })?.creationNotApplied) saveConversationStart(input.directory, input.sourceKey, undefined);
    throw error;
  }
  const model = modelForCreatedSession(created.metadata, input.nnaConfigured, start.model);
  if (input.nnaConfigured && (model.providerID !== start.model.providerID || model.modelID !== start.model.modelID)) {
    throw new Error('NNA created the conversation with a different model. Refresh before sending.');
  }
  const recovered = { ...start, sessionID: created.id, model };
  saveConversationStart(input.directory, input.sourceKey, recovered);
  return recovered;
}

export async function deliverToNewSession(input: NewSessionDeliveryInput): Promise<void> {
  const start = await materialize(input, await startFor(input));
  await input.services.engine.actions.send({ directory: input.directory, sessionID: start.sessionID!, messageID: start.messageID,
    parts: start.parts, model: start.model, agent: input.sendAgent });
  const view = useSessionViewStore.getState();
  const selected = view.currentSessionId === null && (view.currentDraftId ?? 'draft') === input.sourceKey && view.activeDirectory === input.directory;
  if (selected) {
    useSessionViewStore.setState({ currentSessionId: start.sessionID!, currentDraftId: null, activeDirectory: input.directory });
    persistLastActiveSession(start.sessionID!, input.directory);
    try { rememberConversationDraft(null); } catch { toast.message('Conversation started; selection could not be saved.'); }
  }
  try { useConversationDraftStore.getState().remove(input.sourceKey); }
  catch { toast.message('Conversation started; draft cleanup needs a refresh.'); }
  const draft = readDraft(input.directory, input.sourceKey);
  saveDraft(input.directory, input.sourceKey, { ...draft, projectContextPins: { notes: [], plans: [] } });
  dropDraft(input.directory, input.sourceKey);
}

/** P10-51 defaults tolerate old persisted drafts and malformed stored targets. */
function normalizeDraftProjectContextPins(value: unknown): ProjectContextPinTargets {
  return parseProjectContextPins({ project_context_pins: value });
}
