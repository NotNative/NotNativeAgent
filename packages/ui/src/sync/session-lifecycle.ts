// SPDX-License-Identifier: Apache-2.0
/**
 * Session lifecycle actions (doc 04 §F.1) + the engine services seam injected
 * into session-actions. Create keeps the SERVER-AUTHORITATIVE directory;
 * archive writes the time.archived patch; delete tolerates child-cascade 404.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from '../lib/nnd/types.ts';
import type { DirectoryStore, MaterializationRequest } from './types.ts';
import type { SessionMessageLoader } from './session-message-loader.ts';
import { harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import { isNotFound } from './session-actions.ts';

export interface EngineServices {
  activeDirectory: () => string;
  currentSessionId: () => string | null;
  isConnected: () => boolean;
  ensureChild: (directory: string) => StoreApi<DirectoryStore>;
  peekChild: (directory: string) => StoreApi<DirectoryStore> | undefined;
  registerSessionRoute: (sessionID: string, directory: string) => void;
  registerMessageRoute: (messageID: string, sessionID: string) => void;
  enqueueMaterialization: (request: MaterializationRequest, directory: string) => void;
  onStatusEvent: (sessionID: string, status: SessionStatus, directory: string) => void;
  loaderInitializeCreated: (directory: string, sessionID: string, store: StoreApi<DirectoryStore>) => void;
  loaderOptimisticAdd: (directory: string, sessionID: string, store: StoreApi<DirectoryStore>, item: { messageID: string; message: Message; parts: Part[] }) => void;
  loaderOptimisticRemove: (directory: string, sessionID: string, store: StoreApi<DirectoryStore>, messageID: string) => void;
  loaderOptimisticConfirm: (directory: string, sessionID: string, store: StoreApi<DirectoryStore>, messageID: string) => void;
  loaderRefreshTail: (directory: string, sessionID: string, store: StoreApi<DirectoryStore>) => Promise<void>;
  waitForConnection: () => Promise<void>;
  onSelectSession: (sessionID: string, directory: string) => void;
  /** session → owning directory (routing index accessor for actions) */
  directoryForSession?: (sessionID: string) => string | null;
}

/** §F.1 createSession: routing pre-register, child insert, loader claim, select. */
export async function createSession(engine: EngineServices, input: { directory: string; title?: string; parentID?: string }): Promise<Session> {
  const requested = normalizeDirectory(input.directory);
  const result = await harnessClient.createSession({ title: input.title, directory: requested, ...(input.parentID ? { parentID: input.parentID } : {}) });
  if (result.error || !result.data) throw new Error(result.error ?? 'createSession failed');
  const session = result.data;
  // SERVER-AUTHORITATIVE directory, not the requested one
  const sessionDirectory = normalizeDirectory(session.directory ?? requested);
  session.directory = sessionDirectory;
  const store = engine.ensureChild(sessionDirectory);
  engine.registerSessionRoute(session.id, sessionDirectory);
  insertCreatedSession(store, session);
  engine.loaderInitializeCreated(sessionDirectory, session.id, store);
  engine.onSelectSession(session.id, sessionDirectory);
  return session;
}

function insertCreatedSession(store: StoreApi<DirectoryStore>, session: Session): void {
  store.setState((state) => {
    if (state.session.some((existing) => existing.id === session.id)) return {};
    const nextSession = [...state.session, session].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { session: nextSession, ...(session.parentID ? {} : { sessionTotal: state.sessionTotal + 1 }) };
  });
}

/** Archive = UPDATE with time.archived — the event removes it everywhere. */
export async function archiveSessionAction(sessionID: string, directory: string): Promise<void> {
  const result = await harnessClient.updateSession(sessionID, { time: { archived: Date.now() } }, { directory });
  if (result.error) throw new Error(result.error);
}

export async function restoreSessionAction(sessionID: string, directory: string): Promise<void> {
  // sentinel 0: readers classify by truthiness; lists must fetch inclusive
  const result = await harnessClient.updateSession(sessionID, { time: { archived: 0 } }, { directory });
  if (result.error) throw new Error(result.error);
}

/** Shell run (doc 05 §B.3 inputMode=shell): the harness executes; output rides the stream. */
export async function runShellAction(sessionID: string, command: string, directory: string): Promise<void> {
  await harnessClient.runShell(sessionID, { command }, { directory });
}

/** Title rename: PATCH the session record; the event stream reconciles. */
export async function renameSessionAction(sessionID: string, title: string, directory: string): Promise<void> {
  const result = await harnessClient.updateSession(sessionID, { title }, { directory });
  if (result.error) throw new Error(result.error);
}

/** Fork-from-message: creates a new session rooted at that message. */
export async function forkSessionAction(sessionID: string, messageID: string | undefined, directory: string): Promise<string> {
  const result = await harnessClient.forkSession(sessionID, messageID, { directory });
  if (result.error || !result.data) throw new Error(result.error ?? 'fork failed');
  return result.data.id;
}

/** Revert-to-message (§D.6 timeline action); harness-owned Undo primitive. */
export async function revertSessionAction(sessionID: string, messageID: string, directory: string): Promise<void> {
  const result = await harnessClient.revertSession(sessionID, messageID, undefined, { directory });
  if (result.error) throw new Error(result.error);
}
/** Abort the session's running turn (§B.11); idempotent harness-side. */
export async function abortSessionAction(sessionID: string, directory: string): Promise<void> {
  await harnessClient.abortSession(sessionID, { directory });
}

/** Delete: a 404 on a CHILD is expected (cascade) and commits locally. */
export async function deleteSessionAction(engine: EngineServices, sessionID: string, directory: string): Promise<void> {
  const result = await harnessClient.deleteSession(sessionID, { directory });
  const gone = !result.error || isNotFound(result.error, result.response?.status);
  if (!gone) throw new Error(result.error);
  engine.peekChild(directory)?.setState((state) => ({
    session: state.session.filter((session) => session.id !== sessionID),
    ...removeTotalIfRoot(state.session, sessionID),
  }));
}

function removeTotalIfRoot(sessions: Session[], sessionID: string): { sessionTotal: number } | {} {
  const removed = sessions.find((session) => session.id === sessionID);
  return removed && !removed.parentID ? { sessionTotal: Math.max(0, sessions.filter((s) => !s.parentID).length - 1) } : {};
}

export type { PermissionRequest, QuestionRequest, Session, Message, Part, SessionStatus, StoreApi, DirectoryStore, SessionMessageLoader };
