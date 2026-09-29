// SPDX-License-Identifier: Apache-2.0
/** BTW creation staged actions (doc 15 §H.1, creation flow F8). */
import type { StoreApi } from 'zustand/vanilla';
import type { Session } from '../lib/nnd/types.ts';
import { harnessClient, normalizeDirectory } from '../lib/nnd/client.ts';
import type { DirectoryStore } from '../sync/types.ts';
import { btwRiderFor, lastCompletedAssistantID, metadataWithBtwFork } from './btw-context.ts';

export type ModelIdentity = { providerID: string; modelID: string };
type OutgoingPart = { type: 'text'; text: string; synthetic?: boolean } |
  { type: 'file'; url?: string; mime?: string; filename?: string };

export interface CreateBtwInput {
  parent: { sessionID: string; directory: string; runtimeKey: string };
  question: string;
  model: ModelIdentity;
  agent?: string;
  store: StoreApi<DirectoryStore>;
  engine: {
    actions: {
      fork: (sessionID: string, messageID?: string) => Promise<string>;
      send: (input: { directory: string; sessionID: string; parts: OutgoingPart[];
        model: ModelIdentity; agent?: string }) => Promise<void>;
      deleteSession: (sessionID: string, directory: string) => Promise<void>;
    };
  };
  isCurrent: (runtimeKey: string) => boolean;
}

const creating = new Set<string>();

export function clearBtwCreationGuard(): void { creating.clear(); }

function targetFailure(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  return typeof status === 'number';
}

export async function createBtwSession(input: CreateBtwInput): Promise<Session> {
  const runtimeKey = input.parent.runtimeKey;
  if (!input.isCurrent(runtimeKey)) throw new Error('The btw runtime changed');
  if (creating.has(runtimeKey)) throw new Error('A btw session is already starting');
  creating.add(runtimeKey);
  try {
    const question = input.question.trim();
    if (question === '') throw new Error('A btw question is required');
    const parentDirectory = normalizeDirectory(input.parent.directory);
    const parentMessages = input.store.getState().message[input.parent.sessionID] ?? [];
    const boundary = lastCompletedAssistantID(parentMessages);
    const forkBoundary = boundary ?? parentMessages.at(-1)?.id ?? null;
    const childID = await input.engine.actions.fork(input.parent.sessionID, forkBoundary ?? undefined);
    let childDirectory = parentDirectory;
    if (!input.isCurrent(runtimeKey)) {
      await input.engine.actions.deleteSession(childID, parentDirectory).catch(() => undefined);
      throw new Error('The btw runtime changed');
    }
    try {
      let child = await readFreshSession(childID, parentDirectory);
      childDirectory = normalizeDirectory(child.directory ?? parentDirectory);
      child = await tryPatch(child, childDirectory, (metadata) =>
        metadataWithBtwFork(metadata, { originalSessionID: input.parent.sessionID, boundaryMessageID: forkBoundary }));
      child = await patchTitle(child, childDirectory, `btw: ${question.slice(0, 80)}`)
        .catch(() => child);
      const parent = await linkParent(input.parent.sessionID, parentDirectory, childID);
      if (!input.isCurrent(runtimeKey)) {
        await unlinkParentBestEffort(input.parent.sessionID, parentDirectory, childID);
        throw new Error('The btw runtime changed');
      }
      insertBtwSession(input.store, child);
      const rider = btwRiderFor(child.metadata);
      const parts: OutgoingPart[] = rider ? [{ ...rider, type: 'text' as const }] : [];
      parts.push({ type: 'text', text: question });
      await input.engine.actions.send({ directory: childDirectory, sessionID: childID, parts,
        model: input.model, agent: input.agent ?? 'build' });
      return child;
    } catch (error) {
      if (!targetFailure(error)) {
        await unlinkParentBestEffort(input.parent.sessionID, parentDirectory, childID);
        await input.engine.actions.deleteSession(childID, childDirectory).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    creating.delete(runtimeKey);
  }
}

async function readFreshSession(sessionID: string, directory: string): Promise<Session> {
  const result = await harnessClient.getSession(sessionID, { directory });
  if (result.error || !result.data || result.data.id !== sessionID
    || normalizeDirectory(result.data.directory ?? directory) !== directory) {
    throw new Error('Could not read the btw session');
  }
  return result.data;
}

async function tryPatch(session: Session, directory: string,
  mutate: (metadata: Record<string, unknown>) => Record<string, unknown>): Promise<Session> {
  const metadata = mutate(session.metadata ?? {});
  const committed = await harnessClient.updateSession(session.id, { metadata }, { directory });
  if (committed.error || !committed.data || committed.data.id !== session.id
    || normalizeDirectory(committed.data.directory ?? directory) !== directory) {
    throw new Error('Could not update the btw metadata');
  }
  return { ...committed.data, directory: normalizeDirectory(committed.data.directory ?? directory) };
}

async function patchTitle(session: Session, directory: string, title: string): Promise<Session> {
  const committed = await harnessClient.updateSession(session.id, { title }, { directory });
  if (committed.error || !committed.data || committed.data.id !== session.id
    || normalizeDirectory(committed.data.directory ?? directory) !== directory) {
    throw new Error('Could not rename the btw session');
  }
  return { ...committed.data, directory: normalizeDirectory(committed.data.directory ?? directory) };
}

async function linkParent(parentID: string, directory: string, childID: string): Promise<Session> {
  const parent = await readFreshSession(parentID, directory);
  const namespace = { ...namespaceOf(parent.metadata), btwSessionID: childID };
  return tryPatch(parent, directory, (metadata) => ({ ...metadata, openchamber: namespace }));
}

async function unlinkParentBestEffort(parentID: string, directory: string, childID: string): Promise<void> {
  try {
    const parent = await readFreshSession(parentID, directory);
    if (namespaceOf(parent.metadata).btwSessionID !== childID) return;
    const namespace = namespaceOf(parent.metadata);
    delete namespace.btwSessionID;
    await harnessClient.updateSession(parent.id, {
      metadata: { ...(parent.metadata ?? {}), openchamber: namespace },
    }, { directory });
  } catch { /* child deletion remains the authoritative cleanup */ }
}

function insertBtwSession(store: StoreApi<DirectoryStore>, child: Session): void {
  store.setState((state) => {
    if (state.session.some((existing) => existing.id === child.id)) return {};
    const next = [...state.session, child].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    return { session: next };
  });
}

function namespaceOf(metadata: unknown): Record<string, unknown> {
  const root = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  const value = root.openchamber;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> } : {};
}
