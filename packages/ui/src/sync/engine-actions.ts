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
import { createSession, archiveSessionAction, restoreSessionAction, deleteSessionAction, abortSessionAction, runShellAction } from './session-lifecycle.ts';
import { optimisticSend, replyToPermission, replyToQuestion, dismissOpenRequestsForSession } from './session-actions.ts';

export type SessionActionsApi = {
  send: (input: Parameters<typeof optimisticSend>[1]) => Promise<void>;
  createSession: (input: { directory: string; title?: string; parentID?: string }) => Promise<Session>;
  archive: (sessionID: string, directory: string) => Promise<void>;
  restore: (sessionID: string, directory: string) => Promise<void>;
  deleteSession: (sessionID: string, directory: string) => Promise<void>;
  abort: (sessionID: string) => Promise<void>;
  runShell: (sessionID: string, command: string) => Promise<void>;
  replyPermission: (sessionID: string, request: PermissionRequest, reply: 'once' | 'always' | 'reject') => Promise<void>;
  replyQuestion: (sessionID: string, request: QuestionRequest, answers: string[][], reject: boolean) => Promise<void>;
  dismissRequests: (rootSessionID: string) => Promise<void>;
};

export function createSessionActions(
  services: EngineServices,
  children: () => Map<string, StoreApi<DirectoryStore>>,
): SessionActionsApi {
  return {
    send: (input) => optimisticSend(services, input),
    createSession: (input) => createSession(services, input),
    archive: (sessionID, directory) => archiveSessionAction(sessionID, directory),
    restore: (sessionID, directory) => restoreSessionAction(sessionID, directory),
    deleteSession: (sessionID, directory) => deleteSessionAction(services, sessionID, directory),
    runShell: async (sessionID, command) => {
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await runShellAction(sessionID, command, directory);
    },
    abort: async (sessionID) => {
      const directory = services.directoryForSession?.(sessionID) ?? services.activeDirectory();
      await abortSessionAction(sessionID, directory);
    },
    replyPermission: (sessionID, request, reply) => replyToPermission(services, children(), sessionID, request, reply),
    replyQuestion: (sessionID, request, answers, reject) => replyToQuestion(services, children(), sessionID, request, answers, reject),
    dismissRequests: (rootSessionID) => dismissOpenRequestsForSession(services, children(), rootSessionID),
  };
}

export type { QuestionRequest, PermissionRequest };
