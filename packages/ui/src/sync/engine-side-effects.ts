// SPDX-License-Identifier: Apache-2.0
/**
 * Batch side effects (doc 04 §B.2): everything the reducer may NOT do inside a
 * draft — global indices, ordering, timing, streaming, toasts, routing, loader
 * invalidation, the 750ms settle poll, and materialization enqueues. One pass
 * per flush per directory.
 */
import type { StoreApi } from 'zustand/vanilla';
import { toast } from 'sonner';
import { harnessClient } from '../lib/nnd/client.ts';
import type { DirectoryStore, SyncState } from './types.ts';
import type { BatchOutcome } from './reducer-core.ts';
import type { EventRoutingIndex } from './routing-index.ts';
import type { Session } from '../lib/nnd/types.ts';
import { dropSession as dropSessionRoute, registerMessageSession, registerSessionDirectory } from './routing-index.ts';
import { useGlobalSessionStatusStore, useGlobalSessionsStore, useGlobalSyncStore } from './global-stores.ts';
import { useSessionOrderingStore } from './session-ordering.ts';
import { observeActivityOnBusy, settleActivity, useStreamingStore } from './activity-streaming.ts';
import { ensureLiveTiming, reconcileStreaming, settleFromCoveredSnapshot } from './engine-support.ts';
import { getStaleRunningToolMessageID } from './materialization.ts';

export interface SideEffectDeps {
  disposed: () => boolean;
  viewCurrentSessionId: () => string | null;
  enqueueMaterialization: (request: { reason: string; sessionID: string; messageID?: string }, directory: string) => void;
  loaderInvalidate: (directory: string, sessionID: string) => void;
  messagePoll: (directory: string, sessionID: string) => void;
  onGlobalRefresh: () => Promise<void>;
  storeOf: (directory: string) => StoreApi<DirectoryStore> | undefined;
}

export function applySideEffects(directory: string, store: StoreApi<DirectoryStore>, out: BatchOutcome, deps: SideEffectDeps, routing: EventRoutingIndex): void {
  trackStatuses(out);
  settleSessions(directory, store, out, deps);
  surfaceBlockingAsks(out, deps);
  dismissBlocking(out);
  notePartActivity(out);
  registerRoutes(routing, store, directory, out);
  enqueueMaterializations(out, directory, deps);
  scheduleCompletedPolls(out, directory, deps);
  applyArchiveSignals(routing, store, directory, out, deps);
  if (out.projectUpdated) upsertGlobalProject(out.projectUpdated);
  if (out.lspRefresh || out.globalRefresh) void refreshEnrichment(store, directory, out, deps);
}

function trackStatuses(out: BatchOutcome): void {
  for (const { sessionID, status } of out.statusChanges) {
    useGlobalSessionStatusStore.getState().applyEvent(sessionID, status);
    useSessionOrderingStore.getState().observeStatus(sessionID, status);
    if (status.type !== 'idle') {
      observeActivityOnBusy(sessionID);
      ensureLiveTiming(sessionID);
    }
  }
}

function settleSessions(directory: string, store: StoreApi<DirectoryStore>, out: BatchOutcome, deps: SideEffectDeps): void {
  for (const { sessionID, kind } of out.settled) {
    if (!out.statusChanges.some((change) => change.sessionID === sessionID)) {
      useGlobalSessionStatusStore.getState().applyEvent(sessionID, { type: 'idle' });
    }
    settleActivity(sessionID, kind);
    settleFromCoveredSnapshot(sessionID);
    reconcileStreaming(sessionID, store);
    const staleID = getStaleRunningToolMessageID(store, sessionID);
    if (staleID) deps.enqueueMaterialization({ reason: 'settled-running-tool', sessionID, messageID: staleID }, directory);
    const record = findRecord(store, sessionID);
    if (record?.parentID) deps.enqueueMaterialization({ reason: 'child-session-idle', sessionID: record.parentID }, directory);
  }
}

function surfaceBlockingAsks(out: BatchOutcome, deps: SideEffectDeps): void {
  const current = deps.viewCurrentSessionId();
  for (const { sessionID, request } of out.permissionAsks) {
    if (current === sessionID) continue;
    toast.message('Permission requested in a background session', { id: `permission-${sessionID}:${request.id}` });
  }
  for (const { sessionID, request } of out.questionAsks) {
    if (current === sessionID) continue;
    toast.message('Question pending in a background session', { id: `question-${sessionID}:${request.id}` });
  }
}

function dismissBlocking(out: BatchOutcome): void {
  for (const { sessionID, requestID } of out.permissionReplies) toast.dismiss(`permission-${sessionID}:${requestID}`);
  for (const { sessionID, requestID } of out.questionSettled) toast.dismiss(`question-${sessionID}:${requestID}`);
}

function notePartActivity(out: BatchOutcome): void {
  const streaming = useStreamingStore.getState();
  for (const messageID of out.partChangedMessageIDs) streaming.touchStreamingSession(messageID);
}

function registerRoutes(routing: EventRoutingIndex, store: StoreApi<DirectoryStore>, directory: string, out: BatchOutcome): void {
  for (const { messageID, sessionID } of out.messageRoutes) registerMessageSession(routing, messageID, sessionID);
  for (const { sessionID } of out.sessionRoutes) {
    const record = findRecord(store, sessionID);
    if (!record) continue;
    registerSessionDirectory(routing, sessionID, record.directory ?? directory);
    useGlobalSessionsStore.getState().upsertSession(record);
  }
}

function enqueueMaterializations(out: BatchOutcome, directory: string, deps: SideEffectDeps): void {
  for (const request of out.materializations) {
    const shaped = { reason: request.reason, sessionID: request.sessionID, ...(request.messageID ? { messageID: request.messageID } : {}) };
    deps.enqueueMaterialization(shaped, directory);
  }
}

function scheduleCompletedPolls(out: BatchOutcome, directory: string, deps: SideEffectDeps): void {
  for (const { sessionID } of out.messageCompleted) deps.messagePoll(directory, sessionID);
}

function applyArchiveSignals(
  routing: EventRoutingIndex,
  store: StoreApi<DirectoryStore>,
  directory: string,
  out: BatchOutcome,
  deps: SideEffectDeps,
): void {
  for (const sessionID of out.sessionRemoved) {
    useGlobalSessionsStore.getState().removeSession(sessionID);
    useGlobalSessionStatusStore.getState().removeSession(sessionID);
    dropSessionRoute(routing, sessionID);
    deps.loaderInvalidate(directory, sessionID);
    useSessionOrderingStore.getState().remove(sessionID);
    useStreamingStore.getState().clearSession(sessionID);
  }
  for (const { sessionID, record } of out.sessionArchived) {
    // the archived record (already stripped by the reducer) republishes to the
    // global cache's archived bucket; the live index entry is retired either way
    const global = useGlobalSessionsStore.getState();
    if (record) global.upsertSession(record);
    else global.removeSession(sessionID);
    useGlobalSessionStatusStore.getState().removeSession(sessionID);
    dropSessionRoute(routing, sessionID);
    deps.loaderInvalidate(directory, sessionID);
    useSessionOrderingStore.getState().remove(sessionID);
    useStreamingStore.getState().clearSession(sessionID);
  }
}

function upsertGlobalProject(project: unknown): void {
  const globals = useGlobalSyncStore.getState();
  const record = project as { id?: string };
  if (!record?.id) return;
  const next = [...globals.projects.filter((candidate) => candidate['id'] !== record.id), record]
    .sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
  globals.set({ projects: next });
}

async function refreshEnrichment(store: StoreApi<DirectoryStore>, directory: string, out: BatchOutcome, deps: SideEffectDeps): Promise<void> {
  if (out.lspRefresh) {
    const result = await harnessClient.getLsp({ directory });
    if (!deps.disposed() && result.data && !result.error) {
      const current = deps.storeOf(directory) ?? store;
      current.setState({ lsp: result.data as SyncState['lsp'] });
    }
  }
  if (out.globalRefresh) await deps.onGlobalRefresh();
}

function findRecord(store: StoreApi<DirectoryStore>, sessionID: string): Session | undefined {
  return store.getState().session.find((session) => session.id === sessionID);
}
