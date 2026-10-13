// SPDX-License-Identifier: Apache-2.0
/**
 * Event routing index (doc 04 §D.3): which child store receives an event.
 * Rules are precedence-ordered; a stale index may only ever route the VIEWED
 * session to the active directory — otherwise leave events un-routed.
 */
import { normalizeDirectory } from '../lib/nnd/client.ts';

export interface EventRoutingIndex {
  sessionDirectoryById: Map<string, string>;
  messageSessionById: Map<string, string>;
  sessionMessageIdsById: Map<string, Set<string>>;
}

export function createRoutingIndex(): EventRoutingIndex {
  return { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() };
}

export function registerSessionDirectory(index: EventRoutingIndex, sessionID: string, directory: string): void {
  index.sessionDirectoryById.set(sessionID, normalizeDirectory(directory));
}

export function registerMessageSession(index: EventRoutingIndex, messageID: string, sessionID: string): void {
  index.messageSessionById.set(messageID, sessionID);
  let set = index.sessionMessageIdsById.get(sessionID);
  if (!set) {
    set = new Set();
    index.sessionMessageIdsById.set(sessionID, set);
  }
  set.add(messageID);
}

export function dropSession(index: EventRoutingIndex, sessionID: string): void {
  index.sessionDirectoryById.delete(sessionID);
  const ids = index.sessionMessageIdsById.get(sessionID);
  if (ids) for (const id of ids) index.messageSessionById.delete(id);
  index.sessionMessageIdsById.delete(sessionID);
}

export function dropMessage(index: EventRoutingIndex, messageID: string): void {
  const session = index.messageSessionById.get(messageID);
  index.messageSessionById.delete(messageID);
  if (session) index.sessionMessageIdsById.get(session)?.delete(messageID);
}

export interface RoutingResolveInput {
  /** envelope-normalized directory (may be "global" or empty) */
  rawDirectory: string;
  sessionID?: string;
  messageID?: string;
  /** store probes supplied by the provider */
  storeHasSession: (directory: string, sessionID: string) => boolean;
  storeHasMessageParts: (directory: string, messageID: string) => boolean;
  findSessionStore: (sessionID: string) => string | null;
  findPartStore: (messageID: string) => string | null;
  activeDirectory: string;
  activeSessionID: string | null;
  activeStoreExists: boolean;
  singleStore: string | null;
}

export const GLOBAL_DIRECTORY = 'global';

export function resolveDirectoryFromRoutingIndex(index: EventRoutingIndex, input: RoutingResolveInput): string {
  const dir = input.rawDirectory ? normalizeDirectory(input.rawDirectory) : '';
  const { sessionID, messageID } = input;

  // (1) explicit directory whose store ALREADY holds the session
  if (dir && dir !== GLOBAL_DIRECTORY && sessionID && input.storeHasSession(dir, sessionID)) {
    index.sessionDirectoryById.set(sessionID, dir);
    return dir;
  }
  // (2) indexed directory, if that store still exists
  if (sessionID) {
    const indexed = index.sessionDirectoryById.get(sessionID);
    if (indexed && input.storeHasSession(indexed, sessionID)) return indexed;
    // (3) scan all child stores (self-heals the index)
    const scanned = input.findSessionStore(sessionID);
    if (scanned) {
      index.sessionDirectoryById.set(sessionID, scanned);
      return scanned;
    }
  }
  // (4) active-directory fallback — ONLY the viewed session (route what is viewed)
  if (sessionID && input.activeSessionID === sessionID && input.activeStoreExists) {
    return input.activeDirectory;
  }
  // (5) message-addressed payloads
  if (messageID) {
    if (dir && dir !== GLOBAL_DIRECTORY && input.storeHasMessageParts(dir, messageID)) return dir;
    const sessionOfMessage = index.messageSessionById.get(messageID);
    if (sessionOfMessage) {
      const dirOfMessage = index.sessionDirectoryById.get(sessionOfMessage);
      if (dirOfMessage && input.storeHasSession(dirOfMessage, sessionOfMessage)) return dirOfMessage;
    }
    const partStore = input.findPartStore(messageID);
    if (partStore) return partStore;
    if (sessionOfMessage && input.activeSessionID === sessionOfMessage && input.activeStoreExists) {
      // orphaned part event (missing message.updated during a reconnect gap):
      // route to the active directory so it can trigger materialization
      return input.activeDirectory;
    }
  }
  // (6) single-store fallback
  if (input.singleStore) return input.singleStore;
  // (7) normalized directory (usually "global")
  return dir || GLOBAL_DIRECTORY;
}
