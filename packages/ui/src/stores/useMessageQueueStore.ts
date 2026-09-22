// SPDX-License-Identifier: Apache-2.0
/**
 * messageQueueStore (doc 12 §D.6, SLICE-C task 4) — the UI projection over the
 * server-owned runtime at `/api/message-queue` (doc 03 §5.18). Web/desktop
 * talk to a queue the SERVER owns: the projection is never persisted locally
 * (a stale copy would resurrect messages the server already delivered).
 * Optimistic add → POST; every mutation mirrors the server first and refetches
 * the full snapshot on failure (server state wins, never guess). Broadcasts
 * ride `notnative:message-queue.updated {revision, session}` — a notification,
 * so the store re-reads the snapshot (coalesced by revision).
 */
import { create } from 'zustand';
import { runtimeFetch } from '../lib/runtime-fetch.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

export interface QueuedSendConfig {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
}

export interface QueuedItemPublic {
  id: string;
  createdAt: number;
  content: string;
  text: string;
  preview: string;
  sendConfig: QueuedSendConfig;
  agentMention?: string;
  contextPreview?: string;
  attachments: Array<{ id?: string; filename: string; mimeType?: string; size?: number; source?: string; serverPath?: string }>;
}

interface QueueSessionSnapshot {
  sessionId: string;
  directory: string;
  items: QueuedItemPublic[];
  sendingId: string | null;
}

export type FollowUpBehavior = 'steer' | 'queue';

interface MessageQueueState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Key roomId = `${runtimeKey}\n${directory}\n${sessionId}` → items (FIFO head first). */
  queuedMessages: Record<string, QueuedItemPublic[]>;
  sendingIds: Record<string, string[]>;
  lastError: string | null;
  lastRevision: number;
  hydrate: () => Promise<void>;
  resync: () => Promise<void>;
  addToQueue: (directory: string, sessionID: string, input: { content: string; sendConfig: QueuedSendConfig; attachments?: QueuedItemPublic['attachments'] }) => Promise<{ ok: boolean; error?: string }>;
  removeFromQueue: (directory: string, sessionID: string, itemId: string) => Promise<{ ok: boolean; error?: string }>;
  /** §D.6 takeForSend/popToInput: full-payload take for composer re-edit. */
  takeForInput: (directory: string, sessionID: string, itemId: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** §D.6 full-permutation PUT: uses the CURRENT ids order unless given. */
  reorderQueue: (directory: string, sessionID: string, itemIds?: string[]) => Promise<{ ok: boolean; error?: string }>;
  clearQueue: (directory: string, sessionID: string) => Promise<{ ok: boolean; error?: string }>;
  applyRevisionNotification: (revision: number) => Promise<void>;
}

const D1_LIMITS = { itemsPerSession: 20 };

export function queueKey(directory: string, sessionID: string): string {
  return `${getRuntimeKey()}\n${normalizeDirectory(directory)}\n${sessionID}`;
}

/** Test/knowledge seam: apply a raw snapshot body against the live store. */
export function applySnapshotForTests(state: MessageQueueState, body: unknown): Partial<MessageQueueState> {
  const partial = applySnapshot(state, body);
  useMessageQueueStore.setState(partial);
  return partial;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** §D.6 zod-equivalent: a public item must carry id/content/text/preview and a
 *  deliverable sendConfig — malformed items drop the whole session payload. */
function parseItem(raw: unknown): QueuedItemPublic | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sendConfig = asRecord(record['sendConfig']);
  if (typeof record['id'] !== 'string'
    || typeof record['content'] !== 'string'
    || typeof record['preview'] !== 'string'
    || !sendConfig
    || typeof sendConfig['providerID'] !== 'string'
    || typeof sendConfig['modelID'] !== 'string') {
    return null;
  }
  return {
    id: record['id'],
    createdAt: typeof record['createdAt'] === 'number' ? record['createdAt'] : 0,
    content: record['content'],
    text: typeof record['text'] === 'string' ? record['text'] : record['content'],
    preview: record['preview'],
    sendConfig: {
      providerID: sendConfig['providerID'],
      modelID: sendConfig['modelID'],
      ...(typeof sendConfig['agent'] === 'string' ? { agent: sendConfig['agent'] } : {}),
    },
    ...(typeof record['agentMention'] === 'string' ? { agentMention: record['agentMention'] } : {}),
    ...(typeof record['contextPreview'] === 'string' ? { contextPreview: record['contextPreview'] } : {}),
    attachments: Array.isArray(record['attachments'])
      ? (record['attachments'] as unknown[]).filter(asRecord).map((entry) => entry as QueuedItemPublic['attachments'][number])
      : [],
  };
}

/** Full snapshot application: a snapshot owns every session it omits. */
function applySnapshot(state: MessageQueueState, body: unknown): Partial<MessageQueueState> {
  const record = asRecord(body);
  const revision = typeof record?.['revision'] === 'number' ? record['revision'] : 0;
  if (revision < state.lastRevision) return {}; // stale snapshot dropped
  const next: Record<string, QueuedItemPublic[]> = {};
  const sending: Record<string, string[]> = {};
  const sessions = Array.isArray(record?.['sessions']) ? (record!['sessions'] as unknown[]) : [];
  for (const raw of sessions) {
    const session = asRecord(raw);
    if (!session) continue;
    const directory = typeof session['directory'] === 'string' ? session['directory'] : '';
    const sessionId = typeof session['sessionId'] === 'string' ? session['sessionId'] : '';
    const items = Array.isArray(session['items']) ? (session['items'] as unknown[]).map(parseItem).filter((item): item is QueuedItemPublic => item !== null) : [];
    if (items.length === 0 && !directory) continue; // §D.6: directory memory without items still clears — handled by the map absence
    next[queueKey(directory, sessionId)] = items;
    if (session['sendingId'] !== null && session['sendingId'] !== undefined) sending[queueKey(directory, sessionId)] = [String(session['sendingId'])];
  }
  for (const key of Object.keys(state.queuedMessages)) {
    if (!(key in next)) next[key] = []; // omitted ⇒ the server dropped it — full ownership
  }
  return { status: 'ready', queuedMessages: next, sendingIds: { ...state.sendingIds, ...sending }, lastRevision: revision, lastError: null };
}

export const useMessageQueueStore = create<MessageQueueState>((set, get) => ({
  status: 'idle',
  queuedMessages: {},
  sendingIds: {},
  lastError: null,
  lastRevision: 0,

  async hydrate() {
    set({ status: get().status === 'idle' ? 'loading' : get().status });
    let response: Response;
    try {
      response = await runtimeFetch('/api/message-queue');
    } catch (error: unknown) {
      set({ status: 'error', lastError: `message-queue snapshot failed: ${String(error)}` });
      return;
    }
    if (!response.ok) { set({ status: 'error', lastError: `message-queue snapshot failed (${response.status})` }); return; }
    const body = await response.json().catch(() => null);
    set(applySnapshot(get(), body));
  },

  /** Re-request one trailing read (§D.6 resync) — same machinery. */
  async resync() {
    set({ lastRevision: 0 });
    await get().hydrate();
  },

  async addToQueue(directory, sessionID, input) {
    const key = queueKey(directory, sessionID);
    const items = get().queuedMessages[key] ?? [];
    if (items.length >= D1_LIMITS.itemsPerSession) {
      return { ok: false, error: `queue limit reached (${D1_LIMITS.itemsPerSession} items per session)` };
    }
    const optimistic: QueuedItemPublic = {
      id: `queued-local-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      content: input.content,
      text: input.content,
      preview: input.content.length > 100 ? `${input.content.slice(0, 100)}…` : input.content,
      sendConfig: input.sendConfig,
      attachments: input.attachments ?? [],
    };
    set({ queuedMessages: { ...get().queuedMessages, [key]: [...items, optimistic] } });
    let response: Response;
    try {
      response = await runtimeFetch(`/api/message-queue/sessions/${encodeURIComponent(sessionID)}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          directory,
          item: {
            content: input.content,
            attachments: [],
            context: [],
            sendConfig: input.sendConfig,
          },
        }),
      });
    } catch (error: unknown) {
      restoreLocal(set, get, key, items, optimistic.id);
      return { ok: false, error: `queue enqueue failed: ${String(error)}` };
    }
    const body = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) {
      restoreLocal(set, get, key, items, optimistic.id);
      set({ lastError: body?.error ?? `queue enqueue failed (${response.status})` });
      return { ok: false, error: body?.error ?? `queue enqueue failed (${response.status})` };
    }
    set({ lastError: null });
    await get().resync();
    return { ok: true };
  },

  async removeFromQueue(directory, sessionID, itemId) {
    let response: Response;
    try {
      response = await runtimeFetch(`/api/message-queue/sessions/${encodeURIComponent(sessionID)}/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
    } catch (error: unknown) {
      return { ok: false, error: `queue remove failed: ${String(error)}` };
    }
    if (response.status === 409) return { ok: false, error: 'queued item is in flight' };
    if (!response.ok) return { ok: false, error: `queue remove failed (${response.status})` };
    await get().resync();
    return { ok: true };
  },

  async reorderQueue(directory, sessionID, itemIds) {
    const key = queueKey(directory, sessionID);
    const before = get().queuedMessages[key] ?? [];
    const ids = itemIds ?? before.map((item) => item.id);
    const optimistic = ids.flatMap((id) => {
      const found = before.find((item) => item.id === id);
      return found ? [found] : [];
    });
    set({ queuedMessages: { ...get().queuedMessages, [key]: optimistic } });
    let response: Response;
    try {
      response = await runtimeFetch(`/api/message-queue/sessions/${encodeURIComponent(sessionID)}/order`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemIds: ids }),
      });
    } catch {
      set({ queuedMessages: { ...get().queuedMessages, [key]: before } }); // restore the pre-mutation projection
      await get().resync();
      return { ok: false, error: 'queue reorder failed (transport) — snapshot restored' };
    }
    if (!response.ok) {
      set({ queuedMessages: { ...get().queuedMessages, [key]: before } }); // server state wins; never guess
      await get().resync();
      return { ok: false, error: `queue reorder failed (${response.status}) — snapshot restored` };
    }
    set({ lastError: null });
    return { ok: true };
  },

  async takeForInput(directory, sessionID, itemId) {
    let response: Response;
    try {
      response = await runtimeFetch(`/api/message-queue/sessions/${encodeURIComponent(sessionID)}/items/${encodeURIComponent(itemId)}/take`, { method: 'POST' });
    } catch (error: unknown) {
      return { ok: false, error: `queue take failed: ${String(error)}` };
    }
    if (response.status === 409) return { ok: false, error: 'queued item is in flight' };
    if (!response.ok) return { ok: false, error: `queue take failed (${response.status})` };
    const body = await response.json().catch(() => null) as { item?: { content?: string; text?: string } } | null;
    await get().resync();
    return { ok: true, text: body?.item?.text ?? body?.item?.content ?? '' };
  },

  async clearQueue(directory, sessionID) {
    let response: Response;
    try {
      response = await runtimeFetch(`/api/message-queue/sessions/${encodeURIComponent(sessionID)}`, { method: 'DELETE' });
    } catch (error: unknown) {
      return { ok: false, error: `queue clear failed: ${String(error)}` };
    }
    if (!response.ok) return { ok: false, error: `queue clear failed (${response.status})` };
    set({ queuedMessages: { ...get().queuedMessages, [queueKey(directory, sessionID)]: [] } });
    return { ok: true };
  },

  async applyRevisionNotification(revision) {
    if (revision < get().lastRevision) return; // older broadcast dropped
    await get().hydrate();
  },
}));

function restoreLocal(
  set: (partial: Partial<MessageQueueState>) => void,
  get: () => MessageQueueState,
  key: string,
  before: QueuedItemPublic[],
  appliedId: string,
): void {
  // Roll the optimistic entry out of the projection; the server truth arrives
  // on the next snapshot (inputs the composer restores itself).
  const remaining = before.filter((item) => item.id !== appliedId);
  set({ queuedMessages: { ...get().queuedMessages, [key]: remaining } });
}

/** Routing helper used by the composer/tests: items of one directory+session. */
export function queuedItemsOf(directory: string, sessionID: string): QueuedItemPublic[] {
  return useMessageQueueStore.getState().queuedMessages[queueKey(directory, sessionID)] ?? [];
}

export function __resetMessageQueueStoreForTests(): void {
  useMessageQueueStore.setState({ status: 'idle', queuedMessages: {}, sendingIds: {}, lastError: null, lastRevision: 0 });
}
