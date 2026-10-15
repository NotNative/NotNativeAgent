// SPDX-License-Identifier: Apache-2.0
/**
 * Session action surface (doc 04 §E.2-E.4/§F.1): the engine-owned wrapper over
 * session-actions. Callers (chat composer, sidebar, question/permission flows
 * from doc 05) address actions by (session, directory) and let ownership
 * routing resolve the answering store.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { PermissionRequest, QuestionRequest, Session } from '../lib/nnd/types.ts';
import type { MaterializationRequest, DirectoryStore } from './types.ts';
import type { EngineServices } from './session-lifecycle.ts';
import { createSession, archiveSessionAction, restoreSessionAction, deleteSessionAction, abortSessionAction, runShellAction, renameSessionAction, forkSessionAction, revertSessionAction, unrevertSessionAction } from './session-lifecycle.ts';
import { optimisticSend, replyToPermission, replyToQuestion, dismissOpenRequestsForSession } from './session-actions.ts';
import { assertFreshAuthority } from './authority-sync.ts';

export type SessionActionsApi = {
  send: (input: Parameters<typeof optimisticSend>[1]) => Promise<void>;
  createSession: (input: Parameters<typeof createSession>[1]) => Promise<Session>;
  archive: (sessionID: string, directory: string) => Promise<void>;
  restore: (sessionID: string, directory: string) => Promise<void>;
  deleteSession: (sessionID: string, directory: string) => Promise<void>;
  abort: (sessionID: string) => Promise<void>;
  runShell: (sessionID: string, command: string) => Promise<void>;
  rename: (sessionID: string, title: string) => Promise<void>;
  fork: (sessionID: string, messageID: string | undefined) => Promise<string>;
  revert: (sessionID: string, messageID: string) => Promise<void>;
  unrevert: (sessionID: string) => Promise<void>;
  replyPermission: (sessionID: string, request: PermissionRequest, reply: 'once' | 'always' | 'reject') => Promise<void>;
  replyQuestion: (sessionID: string, request: QuestionRequest, answers: string[][], reject: boolean) => Promise<void>;
  dismissRequests: (rootSessionID: string) => Promise<void>;
};

export function createSessionActions(
  services: EngineServices,
  children: () => Map<string, StoreApi<DirectoryStore>>,
): SessionActionsApi {
  return {
    send: (input) => { assertFreshAuthority(); return optimisticSend(services, input); },
    createSession: (input) => { assertFreshAuthority(); return createSession(services, input); },
    archive: (sessionID, directory) => { assertFreshAuthority(); return archiveSessionAction(sessionID, directory); },
    restore: (sessionID, directory) => { assertFreshAuthority(); return restoreSessionAction(sessionID, directory); },
    deleteSession: (sessionID, directory) => { assertFreshAuthority(); return deleteSessionAction(services, sessionID, directory); },
    rename: async (sessionID, title) => {
      assertFreshAuthority();
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await renameSessionAction(sessionID, title, directory);
    },
    fork: async (sessionID, messageID) => {
      assertFreshAuthority();
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      const childID = await forkSessionAction(sessionID, messageID, directory);
      try { assertFreshAuthority(); } catch {
        throw new Error(`NNA created fork ${childID} while native authority was resynchronizing. `
          + 'The fork remains recoverable in NNA; refresh before sending.');
      }
      // §A.2/BTW: a forked child must MATERIALIZE its transcript like any
      // other surfaced session — register the route and enqueue the loader
      // demand; the mock copies entries harness-side with no message events.
      services.registerSessionRoute(childID, directory);
      services.ensureChild(directory);
      services.enqueueMaterialization({ reason: 'ensure-session-messages', sessionID: childID }, directory);
      return childID;
    },
    revert: async (sessionID, messageID) => {
      assertFreshAuthority();
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await revertSessionAction(sessionID, messageID, directory);
    },
    unrevert: async (sessionID) => {
      assertFreshAuthority();
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await unrevertSessionAction(sessionID, directory);
    },
    runShell: async (sessionID, command) => {
      assertFreshAuthority();
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await runShellAction(sessionID, command, directory);
    },
    abort: async (sessionID) => {
      assertFreshAuthority();
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await abortSessionAction(sessionID, directory);
    },
    replyPermission: (sessionID, request, reply) => { assertFreshAuthority(); return replyToPermission(services, children(), sessionID, request, reply); },
    replyQuestion: (sessionID, request, answers, reject) => { assertFreshAuthority(); return replyToQuestion(services, children(), sessionID, request, answers, reject); },
    dismissRequests: (rootSessionID) => { assertFreshAuthority(); return dismissOpenRequestsForSession(services, children(), rootSessionID); },
  };
}

export type { QuestionRequest, PermissionRequest };
