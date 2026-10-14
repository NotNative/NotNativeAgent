
// SPDX-License-Identifier: Apache-2.0
/**
 * Session actions (doc 04 §E.2/E.3/E.4 + §C.2 merge + §D.5 candidates).
 * The optimistic send keeps the messageID through the server round-trip and
 * NEVER rolls back an ambiguous failure the confirmation refetch found.
 */
import type { StoreApi } from 'zustand/vanilla';
import { ascendingId, harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import { MAX_RECORDED_SEND_FAILURES, SEND_CONFIRMATION_REFETCH_LIMIT, SEND_CONFIRMATION_REFETCH_ATTEMPTS, SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS } from './types.ts';
import type { MaterializationRequest, DirectoryStore } from './types.ts';
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from '../lib/nnd/types.ts';
import { truncateAtMessageId, messagesBefore } from './message-ordering.ts';
import { getStaleRunningToolMessageID } from './materialization.ts';
import type { EngineServices } from './session-lifecycle.ts';
import { getSessionKnowledge, recordSessionKnowledgeDelivered } from '../lib/session-knowledge-api.ts';
import { nnaOwnsPermissionReview } from '../lib/nnd/permission-policy.ts';
import { useGlobalSyncStore } from './global-stores.ts';
import { adoptSessionProjection, sessionProjection } from './nna-projection.ts';
import { shouldSkipStaleSessionEvent } from './event-equality.ts';
import { assertFreshAuthority } from './authority-sync.ts';
import { promptWireParts } from './native-prompt-parts.ts';

export interface SendFailureRecord {
  at: number;
  sessionID: string;
  messageID: string;
  status?: number;
  reason: string;
  transportTagged: boolean;
  confirmedPresent: boolean;
  rolledBack: boolean;
  confirmationAttempts: number;
  confirmationChecked: boolean;
  outcome: 'confirmed' | 'rolled-back' | 'unconfirmed';
  cause: unknown;
}

const sendFailureLog: SendFailureRecord[] = [];

export function getSendFailureLog(): readonly SendFailureRecord[] {
  return sendFailureLog;
}

export function recordSendFailure(record: SendFailureRecord): void {
  sendFailureLog.unshift(record);
  while (sendFailureLog.length > MAX_RECORDED_SEND_FAILURES) sendFailureLog.pop();
}

export function clearSendFailureLog(): void {
  sendFailureLog.length = 0;
}

/** Ambiguous = the request may have been processed (a retry would double-send). */
export function isAmbiguousSendFailure(error: unknown): boolean {
  const err = error as { status?: number; name?: string; message?: string; transportTagged?: boolean };
  if (err?.transportTagged) return true;
  if (err?.status === 503 || err?.status === 504 || err?.status === 408) return true;
  const name = String(err?.name ?? '');
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (error instanceof Error) {
    const message = String(err?.message ?? '');
    if (/timeout|timed out|failed to fetch|networkerror|network error|gateway timeout|econnreset|socket hang up/i.test(message)) return true;
  }
  return false;
}

/** Confirmation refetch: reconnect-bound wait, ≤3 attempts at 250·2^(n−1). */
export async function confirmSendLanded(
  sessionID: string,
  directory: string,
  messageID: string,
  waitWhileDisconnected: () => Promise<void>,
): Promise<{ found: boolean; attempts: number }> {
  await waitWhileDisconnected(); // bounded by SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS
  let attempts = 0;
  for (let attempt = 0; attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS; attempt += 1) {
    attempts += 1;
    const result = await harnessClient.listMessages(sessionID, SEND_CONFIRMATION_REFETCH_LIMIT, { directory });
    if (result.data && Array.isArray(result.data)) {
      const found = result.data.some((entry) => entry.info.id === messageID);
      if (found) return { found: true, attempts };
    }
    if (attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS - 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * 2 ** attempt));
    }
  }
  return { found: false, attempts };
}


/** §E.2 — the full optimistic sequence. Resolves after server confirmation
 * OR silently after an ambiguous failure is CONFIRMED (no rollback). */
export async function optimisticSend(
  engine: EngineServices,
  input: {
    directory: string;
    sessionID: string;
    delivery?: 'steer' | 'queue';
    parts: Array<
      { type: 'text'; text: string; synthetic?: boolean; systemContext?: string } |
      { type: 'file'; url?: string; mime?: string; filename?: string }
    >;
    model: { providerID: string; modelID: string; variant?: string };
    agent?: string;
  },
): Promise<void> {
  const directory = normalizeDirectory(input.directory);
  await engine.waitForConnection();
  const store = engine.ensureChild(directory);
  const knowledge = await pendingKnowledge(directory, input.sessionID);
  // A gap can be discovered while connection or knowledge preflight is pending.
  assertFreshAuthority();
  const sendInput: optimisticSendInput = knowledge === undefined
    ? input
    : { ...input, parts: [knowledge.part, ...input.parts] };
  const messageID = ascendingId('msg');
  addOptimisticDraft(engine, store, directory, {
    ...sendInput,
  }, messageID);
  const previousStatus = store.getState().session_status[input.sessionID];
  markStatus(store, engine, directory, input.sessionID, { type: 'busy' });
  try {
    await dispatchPrompt(engine, directory, sendInput, messageID, store);
    if (knowledge) recordKnowledge(directory, input.sessionID, knowledge.signature);
  } catch (error) {
    const confirmed = await handleSendFailure(engine, store, directory, input, messageID, previousStatus, error);
    if (confirmed && knowledge) recordKnowledge(directory, input.sessionID, knowledge.signature);
  }
}

async function pendingKnowledge(directory: string, sessionID: string): Promise<{
  text: string; signature: string; part: { type: 'text'; text: string; synthetic: true; systemContext: 'session-knowledge' };
} | undefined> {
  try {
    const pending = await getSessionKnowledge(directory, sessionID);
    if (pending.unavailable || pending.text === '' || pending.signature === '') return undefined;
    return {
      text: pending.text,
      signature: pending.signature,
      part: { type: 'text', text: pending.text, synthetic: true, systemContext: 'session-knowledge' },
    };
  } catch {
    return undefined;
  }
}

function recordKnowledge(directory: string, sessionID: string, signature: string): void {
  void recordSessionKnowledgeDelivered({ directory, sessionId: sessionID, signature })
    .catch(() => undefined);
}

function addOptimisticDraft(
  engine: EngineServices,
  store: StoreApi<DirectoryStore>,
  directory: string,
  input: optimisticSendInput,
  messageID: string,
): void {
  const created = Date.now();
  const optimisticMessage: Message = {
    id: messageID,
    sessionID: '', // optimistic marker: no server sessionID yet
    role: 'user',
    time: { created },
    agent: input.agent ?? 'build',
    model: {
      providerID: input.model.providerID,
      modelID: input.model.modelID,
      ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
    },
  } as Message;
  const optimisticParts: Part[] = input.parts.map((part) =>
    part.type === 'text'
      ? ({ id: ascendingId('prt'), sessionID: '', messageID, type: 'text', text: part.text,
          ...(part.synthetic ? { synthetic: true } : {}) } as unknown as Part)
      : ({ id: ascendingId('prt'), sessionID: '', messageID, type: 'file', url: part.url ?? '', mime: part.mime ?? 'application/octet-stream', filename: part.filename } as unknown as Part),
  );
  engine.loaderOptimisticAdd(directory, input.sessionID, store, { messageID, message: optimisticMessage, parts: optimisticParts });
}

function markStatus(store: StoreApi<DirectoryStore>, engine: EngineServices, directory: string, sessionID: string, status: SessionStatus): void {
  store.setState((state) => ({ session_status: { ...state.session_status, [sessionID]: status } }));
  engine.onStatusEvent(sessionID, status, directory);
}

async function dispatchPrompt(
  engine: EngineServices,
  directory: string,
  input: optimisticSendInput,
  messageID: string,
  store: StoreApi<DirectoryStore>,
): Promise<void> {
  assertFreshAuthority();
  const nativeUploads = nnaOwnsPermissionReview(store.getState().config)
    || nnaOwnsPermissionReview(useGlobalSyncStore.getState().config);
  const parts = await promptWireParts(input.sessionID, directory, messageID, input.parts, nativeUploads);
  assertFreshAuthority();
  const result = await harnessClient.promptAsync(
    input.sessionID,
    {
      messageID,
      model: {
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        // Why: no variant/delivery here — NNA rejects per-prompt overrides on
        // prompt_async (nnd_variant_override_unsupported / nnd_delivery_override_unsupported).
      },
      ...(input.agent ? { agent: input.agent } : {}),
      parts,
    },
    { directory },
  );
  if (result.error) {
    // Preserve NNA's structured failure code: machine decisions (busy vs
    // conflict vs duplicate) must not re-infer intent from message prose.
    throw Object.assign(new Error(result.error), { status: result.response?.status, code: result.code, transportTagged: result.response === undefined });
  }
  if (result.response && result.response.status !== 204) {
    throw Object.assign(new Error(`prompt_async unexpected status ${result.response.status}`), { status: result.response.status, transportTagged: false });
  }
  // 204 says nothing: the message.updated echo reconciles; parts reconcile too.
  engine.loaderOptimisticConfirm(directory, input.sessionID, store, messageID);
  void engine.loaderRefreshTail(directory, input.sessionID, store);
}

/** Ambiguous = the request may have been processed (a retry would double-send). */
async function handleSendFailure(
  engine: EngineServices,
  store: StoreApi<DirectoryStore>,
  directory: string,
  input: optimisticSendInput,
  messageID: string,
  previousStatus: SessionStatus | undefined,
  error: unknown,
): Promise<boolean> {
  const status = (error as { status?: number }).status;
  const ambiguous = isAmbiguousSendFailure(error);
  if (!ambiguous) {
    recordSendFailure({ at: Date.now(), sessionID: input.sessionID, messageID, status, reason: String(error).slice(0, 200), transportTagged: false, confirmedPresent: false, rolledBack: true, confirmationAttempts: 0, confirmationChecked: false, outcome: 'rolled-back', cause: error });
    engine.loaderOptimisticRemove(directory, input.sessionID, store, messageID);
    restoreStatus(store, engine, directory, input.sessionID, previousStatus);
    throw error;
  }
  const confirmation = await confirmSendLanded(input.sessionID, directory, messageID, async () => {
    const startedAt = Date.now();
    while (!engine.isConnected() && Date.now() - startedAt < SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  });
  if (confirmation.found) {
    // RESOLVE QUIETLY — rolling back could double-send through the queue
    recordSendFailure({ at: Date.now(), sessionID: input.sessionID, messageID, status, reason: String(error).slice(0, 200), transportTagged: true, confirmedPresent: true, rolledBack: false, confirmationAttempts: confirmation.attempts, confirmationChecked: true, outcome: 'confirmed', cause: error });
    engine.loaderOptimisticConfirm(directory, input.sessionID, store, messageID);
    await engine.loaderRefreshTail(directory, input.sessionID, store);
    return true;
  }
  recordSendFailure({ at: Date.now(), sessionID: input.sessionID, messageID, status, reason: String(error).slice(0, 200), transportTagged: true, confirmedPresent: false, rolledBack: true, confirmationAttempts: confirmation.attempts, confirmationChecked: true, outcome: 'unconfirmed', cause: error });
  engine.loaderOptimisticRemove(directory, input.sessionID, store, messageID);
  restoreStatus(store, engine, directory, input.sessionID, previousStatus);
  throw error;
}

function restoreStatus(store: StoreApi<DirectoryStore>, engine: EngineServices, directory: string, sessionID: string, previousStatus: SessionStatus | undefined): void {
  markStatus(store, engine, directory, sessionID, previousStatus ?? { type: 'idle' });
}

type optimisticSendInput = Parameters<typeof optimisticSend>[1];

/** §E.4 — ownership routing: the session RECORD's directory answers. */
export function resolveDirectoryForBlockingRequest(
  engine: EngineServices,
  kind: 'question' | 'permission',
  sessionID: string,
  childStores: Map<string, StoreApi<DirectoryStore>>,
): string | null {
  for (const [directory, store] of childStores) {
    const bucket = kind === 'question' ? store.getState().question[sessionID] : store.getState().permission[sessionID];
    if (bucket && bucket.length > 0) {
      const record = store.getState().session.find((s) => s.id === sessionID);
      const recordDirectory = ((record?.directory ?? '') || ((record as unknown as { project?: { worktree?: string } } | undefined)?.project?.worktree ?? '')).trim();
      if (recordDirectory) return normalizeDirectory(recordDirectory);
      return directory;
    }
  }
  const active = engine.activeDirectory();
  if (active) return active;
  return null;
}

export function isNotFound(errorText: string | undefined, status: number | undefined): boolean {
  return status === 404 || /not.?found/i.test(errorText ?? '');
}

export async function replyToPermission(
  engine: EngineServices,
  childStores: Map<string, StoreApi<DirectoryStore>>,
  sessionID: string,
  request: PermissionRequest,
  reply: 'once' | 'always' | 'reject',
): Promise<void> {
  if (reply === 'always') throw new Error('Remembered permission approvals are not supported');
  if (nnaOwnsPermissionReview(useGlobalSyncStore.getState().config)
    || [...childStores.values()].some((store) => (store.getState().permission[sessionID]?.some((item) => item.id === request.id))
      && nnaOwnsPermissionReview(store.getState().config))) {
    throw new Error('NNA owns permission review for this runtime');
  }
  const directory = resolveDirectoryForBlockingRequest(engine, 'permission', sessionID, childStores);
  const result = await harnessClient.replyToPermission(request.id, reply, undefined, directory ? { directory } : undefined);
  const settled = !result.error || isNotFound(result.error, result.response?.status);
  if (!settled) throw new Error(result.error);
  removeLocalPermission(childStores, sessionID, request.id);
  if (isNotFound(result.error, result.response?.status)) {
    // already settled elsewhere: converge the trailing tool via materialization
    const stale = findStaleRunningToolStore(childStores, sessionID);
    if (stale) engine.enqueueMaterialization({ reason: 'settled-running-tool', sessionID, messageID: stale.messageID }, stale.directory);
  }
}

export async function replyToQuestion(
  engine: EngineServices,
  childStores: Map<string, StoreApi<DirectoryStore>>,
  sessionID: string,
  request: QuestionRequest,
  answers: string[][],
  reject: boolean,
): Promise<void> {
  const directory = resolveDirectoryForBlockingRequest(engine, 'question', sessionID, childStores);
  const normalized = (answers ?? []).map((answer) => (Array.isArray(answer) ? answer : [String(answer)]));
  const result = reject
    ? await harnessClient.rejectQuestion(request.id, directory ? { directory } : undefined)
    : await harnessClient.replyToQuestion(request.id, normalized, directory ? { directory } : undefined);
  const settled = !result.error || isNotFound(result.error, result.response?.status);
  removeLocalQuestion(childStores, sessionID, request.id);
  if (!settled) throw new Error(result.error);
  if (isNotFound(result.error, result.response?.status)) {
    const stale = findStaleRunningToolStore(childStores, sessionID);
    if (stale) engine.enqueueMaterialization({ reason: 'settled-running-tool', sessionID, messageID: stale.messageID }, stale.directory);
  }
}

/** Send-path supersede: clear the session SUBTREE's open requests first. */
export async function dismissOpenRequestsForSession(
  engine: EngineServices,
  childStores: Map<string, StoreApi<DirectoryStore>>,
  rootSessionID: string,
): Promise<void> {
  const subtree = computeSubtreeIds(childStores, rootSessionID);
  const pendingPermissions: Array<{ directory: string; request: PermissionRequest }> = [];
  const pendingQuestions: Array<{ directory: string; request: QuestionRequest }> = [];
  for (const [directory, store] of childStores) {
    for (const sessionID of subtree) {
      const state = store.getState();
      for (const request of state.permission[sessionID] ?? []) pendingPermissions.push({ directory, request });
      for (const request of state.question[sessionID] ?? []) pendingQuestions.push({ directory, request });
    }
  }
  for (const [, store] of childStores) {
    const state = store.getState();
    const permission = { ...state.permission };
    const question = { ...state.question };
    let touched = false;
    for (const sessionID of subtree) {
      if (permission[sessionID]) {
        delete permission[sessionID];
        touched = true;
      }
      if (question[sessionID]) {
        delete question[sessionID];
        touched = true;
      }
    }
    if (touched) store.setState({ permission, question });
  }
  await Promise.allSettled([
    ...pendingPermissions.map(({ directory, request }) => harnessClient.replyToPermission(request.id, 'reject', undefined, { directory }).catch(() => undefined)),
    ...pendingQuestions.map(({ directory, request }) => harnessClient.rejectQuestion(request.id, { directory }).catch(() => undefined)),
  ]);
  void engine;
}

export function computeSubtreeIds(childStores: Map<string, StoreApi<DirectoryStore>>, rootSessionID: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const [, store] of childStores) {
    for (const session of store.getState().session) {
      if (!session.parentID) continue;
      const list = childrenByParent.get(session.parentID) ?? [];
      if (!childrenByParent.has(session.parentID)) childrenByParent.set(session.parentID, list);
      list.push(session.id);
    }
  }
  const out = new Set<string>([rootSessionID]);
  const queue = [rootSessionID];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenByParent.get(current) ?? []) {
      if (out.has(child)) continue;
      if (child <= rootSessionID) continue; // ids ascend within a subtree
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

function removeLocalPermission(childStores: Map<string, StoreApi<DirectoryStore>>, sessionID: string, requestID: string): void {
  for (const [, store] of childStores) {
    const bucket = store.getState().permission[sessionID];
    if (!bucket?.some((p) => p.id === requestID)) continue;
    const permission = { ...store.getState().permission };
    const nextBucket = bucket.filter((p) => p.id !== requestID);
    if (nextBucket.length === 0) delete permission[sessionID];
    else permission[sessionID] = nextBucket;
    store.setState({ permission });
  }
}

function removeLocalQuestion(childStores: Map<string, StoreApi<DirectoryStore>>, sessionID: string, requestID: string): void {
  for (const [, store] of childStores) {
    const bucket = store.getState().question[sessionID];
    if (!bucket?.some((q) => q.id === requestID)) continue;
    const question = { ...store.getState().question };
    const nextBucket = bucket.filter((q) => q.id !== requestID);
    if (nextBucket.length === 0) delete question[sessionID];
    else question[sessionID] = nextBucket;
    store.setState({ question });
  }
}

function findStaleRunningToolStore(childStores: Map<string, StoreApi<DirectoryStore>>, sessionID: string): { directory: string; messageID: string } | null {
  for (const [directory, store] of childStores) {
    const messageID = getStaleRunningToolMessageID(store, sessionID);
    if (messageID) return { directory, messageID };
  }
  return null;
}

// ── bootstrap merge + reconnect candidates ───────────────────────────────────

/** Closed-hierarchy merge (doc 04 §C.2): incoming records win; cached parents
 * of incoming children are retained; children of tombstoned (absent) ancestors
 * are excluded; post-baseline live upserts overlay the snapshot and deletions
 * remove records from even a stale incoming list. */
export function mergeBootstrapLists(
  current: Session[],
  rootSessions: Session[],
  childSessions: Session[] | null,
  liveEventIdsAfterBaseline: Set<string>,
  deletedIdsAfterBaseline: Set<string> = new Set(),
): Session[] {
  const cachedById = new Map<string, Session>();
  for (const session of current) cachedById.set(session.id, session);

  const incoming = [...rootSessions, ...(childSessions ?? [])].filter((session) => !deletedIdsAfterBaseline.has(session.id));
  const incomingIds = new Set(incoming.map((session) => session.id));
  const merged = new Map<string, Session>();
  for (const session of incoming) {
    // tombstoned ancestor: the parent is neither incoming nor cached ⇒ excluded
    if (session.parentID && !incomingIds.has(session.parentID) && !cachedById.has(session.parentID)) continue;
    const cached = cachedById.get(session.id);
    if (sessionProjection(session) && shouldSkipStaleSessionEvent(cached, session)) merged.set(session.id, cached!);
    else merged.set(session.id, adoptSessionProjection(cached, session));
  }
  // retained cached parents complete the hierarchy for surviving children
  for (const child of merged.values()) {
    if (!child.parentID || merged.has(child.parentID)) continue;
    const cachedParent = cachedById.get(child.parentID);
    if (cachedParent) merged.set(child.parentID, cachedParent);
  }
  // post-baseline LIVE events overlay back (their id sets survive; deletions stay deleted)
  for (const [sessionID, cached] of cachedById) {
    if (liveEventIdsAfterBaseline.has(sessionID) && !deletedIdsAfterBaseline.has(sessionID)) merged.set(sessionID, cached);
  }
  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** §D.5(1): sessions worth resyncing after a stream gap. */
export function getReconnectCandidateIds(store: StoreApi<DirectoryStore>, viewedSessionID: string | null, activeDirectory: string, storeDirectory: string): string[] {
  const state = store.getState();
  const ids = new Set<string>();
  for (const session of state.session) {
    const status = state.session_status[session.id];
    if (status && status.type !== 'idle') ids.add(session.id);
    if (session.parentID) ids.add(session.parentID);
  }
  for (const [sessionID, messages] of Object.entries(state.message)) {
    const trailing = messages[messages.length - 1];
    const renderable = messages.length > 0 && messages.every((m) => state.part[m.id] !== undefined);
    if (!renderable) ids.add(sessionID);
    if (trailing && trailing.role === 'assistant' && trailing.time.completed === undefined) ids.add(sessionID);
  }
  if (viewedSessionID && activeDirectory === storeDirectory && state.session.some((s) => s.id === viewedSessionID)) {
    ids.add(viewedSessionID);
  }
  return [...ids];
}

export { messagesBefore, truncateAtMessageId };
