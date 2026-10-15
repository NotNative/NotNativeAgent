// SPDX-License-Identifier: Apache-2.0
/**
 * Draft persistence + client-held queue (doc 05 §B.8/§B.10, P3a client-held
 * until the doc-03 server queue lands; keys already namespaced per doc 04 §G).
 * Identity = (runtimeKey, directory, sessionKey); tombstones beat echoes.
 */
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import type { Part } from '../lib/nnd/types.ts';

const DRAFT_KEY = 'nnd.draft.v1';
const DEBOUNCE_MS = 120;

export type DraftSessionKey = string; // real session id | 'draft' | 'btw-pending:<id>'

export interface DraftAttachment {
  name: string;
  mime: string;
  dataUrl?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  mentions: string[];
  attachments: DraftAttachment[];
  queuedAt: number;
}

export interface ConversationStart {
  operationId: string; messageID: string; sessionID?: string; fingerprint?: string;
  title: string; model: { providerID: string; modelID: string };
  reviewMode: 'auto-review' | 'unattended';
  parts: ({ type: 'text'; text: string; synthetic?: boolean } | { type: 'file'; url?: string; filename?: string; mime?: string })[];
}

export interface DraftRecord {
  start?: ConversationStart;
  text: string;
  attachments: DraftAttachment[];
  queue: QueuedMessage[];
  projectContextPins: { notes: string[]; plans: string[] };
  updatedAt: number;
}

const EMPTY: DraftRecord = { text: '', attachments: [], queue: [],
  projectContextPins: { notes: [], plans: [] }, updatedAt: 0 };

type DraftStore = Record<string, DraftRecord | { tombstone: true }>;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let storeCache: DraftStore | null = null;
let draftRevision = 0;
const draftListeners = new Set<() => void>();
function changed(): void { draftRevision += 1; for (const listener of draftListeners) listener(); }
export function subscribeDraftChanges(listener: () => void): () => void { draftListeners.add(listener); return () => { draftListeners.delete(listener); }; }
export function getDraftRevision(): number { return draftRevision; }

function readStore(): DraftStore {
  if (storeCache) return storeCache;
  try {
    const parsed = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '') as DraftStore;
    storeCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    storeCache = {};
  }
  return storeCache;
}

function writeStore(store: DraftStore): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(store));
  } catch {
    /* quota: tolerate, next debounce retries */
  }
}

export function draftKey(directory: string, sessionKey: DraftSessionKey): string {
  return `${getRuntimeKey()}\n${normalizeDirectory(directory)}\n${sessionKey}`;
}

export function readDraft(directory: string, sessionKey: DraftSessionKey): DraftRecord {
  const value = readStore()[draftKey(directory, sessionKey)];
  if (!value || 'tombstone' in value) return { ...EMPTY };
  // Old drafts may carry NND's removed permission switch. Never round-trip it.
  const { autoAccept: _legacyPermissionSwitch, ...draft } = value as DraftRecord & { autoAccept?: unknown };
  return { ...EMPTY, ...draft };
}

export function saveDraft(directory: string, sessionKey: DraftSessionKey,
  partial: Omit<DraftRecord, 'updatedAt' | 'projectContextPins'> & { projectContextPins?: DraftRecord['projectContextPins'] }): void {
  const { autoAccept: _legacyPermissionSwitch, ...record } = partial as Omit<DraftRecord, 'updatedAt'> & { autoAccept?: unknown };
  const store = readStore();
  store[draftKey(directory, sessionKey)] = {
    ...(readDraft(directory, sessionKey).start ? { start: readDraft(directory, sessionKey).start } : {}),
    ...record,
    projectContextPins: record.projectContextPins ?? readDraft(directory, sessionKey).projectContextPins,
    updatedAt: Date.now(),
  };
  changed();
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    writeStore(storeCache!);
  }, DEBOUNCE_MS);
}

export function flushDraftsNow(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (storeCache) writeStore(storeCache);
}

/** Test support: drop the in-memory cache so a test starts from clean storage. */
export function __resetDraftStoreForTests(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  storeCache = null;
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing */
  }
}

export function dropDraft(directory: string, sessionKey: DraftSessionKey): void {
  delete readStore()[draftKey(directory, sessionKey)];
  flushDraftsNow();
}

/** Tombstone BEFORE any queued write so a deleted draft cannot resurrect. */
export function tombstoneDraft(directory: string, sessionKey: DraftSessionKey): void {
  readStore()[draftKey(directory, sessionKey)] = { tombstone: true };
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  writeStore(readStore());
}

/** Enqueue-deledger: versioned pending-write rejection for old runtimes. */
export function rejectStaleRuntimeWrites(): void {
  if (!storeCache) return;
  for (const [key, value] of Object.entries(storeCache)) {
    if ('tombstone' in value) continue;
    if (!key.startsWith(`${getRuntimeKey()}\n`)) delete storeCache[key];
  }
  flushDraftsNow();
}

/** Attachment -> file part factory at send (doc-02 §6 file part shape). */
export function attachmentParts(attachments: DraftAttachment[], messageID: string): Part[] {
  return attachments.map((attachment, index) => ({
    id: `prt_${messageID}_p${index}`,
    sessionID: '',
    messageID,
    type: 'file',
    filename: attachment.name,
    mime: attachment.mime,
    url: attachment.dataUrl ?? '',
  } as unknown as Part));
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDraftsNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDraftsNow();
  });
}

/** Persist the recovery identity before any native create or send operation. */
export function saveConversationStart(directory: string, sessionKey: string, start: ConversationStart | undefined): void {
  const store = { ...readStore(), [draftKey(directory, sessionKey)]: { ...readDraft(directory, sessionKey), start } };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(store));
  storeCache = store; changed();
}
