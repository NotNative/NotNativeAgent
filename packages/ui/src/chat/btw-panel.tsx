// SPDX-License-Identifier: Apache-2.0
/** Parent-side BTW controls. State comes from the session-organization
 * store; sessions created before the store existed keep the legacy metadata
 * read/write path (mock-runtime door). */
import type { ReactNode } from 'react';
import type { Session } from '../lib/nnd/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { toast } from 'sonner';
import { normalizeDirectory, harnessClient } from '../lib/nnd/client.ts';
import { useSessionOrgStore } from '../stores/useSessionOrgStore.ts';
import { parseBtwRecord } from './btw-org.ts';
import { metadataMarkBtwPromoted, metadataUnlinkBtwParent, parseBtwMetadata } from './btw-context.ts';

export interface BtwPanelProps {
  session: Session;
  parentSessionID: string;
  childSessionID: string;
  directory: string;
  store: {
    getState(): {
      session: Session[];
      message: Record<string, unknown>;
    };
  };
  engine: SyncEngine;
  onSelectSession: (sessionID: string, directory: string) => void;
}

export function BtwPanel(props: BtwPanelProps): ReactNode {
  const directory = normalizeDirectory(props.directory);
  const childRecord = useSessionOrgStore((state) => state.recordsByDirectory[directory]?.[props.childSessionID]);
  const parentRecord = useSessionOrgStore((state) => state.recordsByDirectory[directory]?.[props.parentSessionID]);
  const orgState = parseBtwRecord(childRecord);
  const legacy = parseBtwMetadata(props.session.metadata);
  const useOrgPath = childRecord?.btwMarker !== undefined;
  const childWindow = useOrgPath ? orgState : legacy;
  if (!childWindow.active && !childWindow.promoted) return null;
  const promote = async (): Promise<void> => {
    if (!useOrgPath) return promoteLegacy(props);
    const store = useSessionOrgStore.getState();
    const before = childRecord;
    await store.applyOp(directory, props.childSessionID, 'btw.markPromoted');
    try {
      await store.applyOp(directory, props.parentSessionID, 'btw.clearChild', { childSessionID: props.childSessionID });
    } catch {
      // Best-effort rollback keeps the pre-promotion marker visible; the
      // explicit `promoted:false` override reverts the flag the mark set.
      if (before?.btwMarker) {
        await store.applyOp(directory, props.childSessionID, 'btw.setMarker',
          { marker: before.btwMarker, promoted: false }).catch(() => undefined);
      }
      throw new Error('Could not remove the BTW link');
    }
    props.onSelectSession(props.childSessionID, directory);
  };
  const destroy = async (): Promise<void> => {
    try {
      if (useOrgPath) {
        await useSessionOrgStore.getState().applyOp(directory, props.parentSessionID, 'btw.clearChild',
          { childSessionID: props.childSessionID }).catch(() => undefined);
      } else {
        await unlinkParentLegacy(props.parentSessionID, directory, props.childSessionID).catch(() => undefined);
      }
      await props.engine.actions.deleteSession(props.childSessionID, directory);
    } catch {
      throw new Error('Could not remove the BTW session');
    }
  };
  return <div className="mx-auto flex w-full max-w-3xl items-center justify-between rounded-lg border border-amber-500/20 bg-amber-950/20 px-3 py-2" data-testid="btw-panel">
    <div>
      <p className="text-sm text-amber-100">{props.session.title || 'BTW conversation'}</p>
      <p className="text-[11px] text-amber-300/70">{(useOrgPath
        ? parentRecord?.btwChildOf === props.childSessionID
        : metadataSessionID(props.session.metadata) === props.childSessionID)
        ? 'Active BTW fork' : 'Submission BTW fork'}</p>
    </div>
    <div className="flex items-center gap-2">
      <button type="button" className="rounded border border-white/15 px-2 py-1 text-xs text-neutral-200 hover:border-white/30"
        data-testid="btw-promote"
          onClick={() => { void promote().catch((error: unknown) => toast.error(errorMessage(error))); }}>Promote</button>
      <button type="button" className="rounded border border-red-500/40 px-2 py-1 text-xs text-red-200 hover:border-red-400"
        data-testid="btw-destroy"
      onClick={() => { void destroy().catch((error: unknown) => toast.error(errorMessage(error))); }}>Remove</button>
      <button type="button" className="rounded border border-blue-500/30 px-2 py-1 text-xs text-blue-200 hover:border-blue-400"
        onClick={() => props.onSelectSession(props.childSessionID, normalizeDirectory(props.directory))}>Open</button>
    </div>
  </div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not update the BTW session';
}

function metadataSessionID(metadata: unknown): string | undefined {
  const namespace = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).openchamber : undefined;
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) return undefined;
  const value = (namespace as Record<string, unknown>).btwSessionID;
  return typeof value === 'string' ? value : undefined;
}

async function readSession(sessionID: string, directory: string): Promise<Session> {
  const result = await harnessClient.getSession(sessionID, { directory });
  if (result.error || !result.data || result.data.id !== sessionID
    || normalizeDirectory(result.data.directory ?? directory) !== directory) {
    throw new Error('Could not read the BTW session');
  }
  return result.data;
}

async function patchSessionMetadata(session: Session, directory: string,
  mutate: (metadata: Record<string, unknown>) => Record<string, unknown>): Promise<Session> {
  const metadata = mutate(session.metadata ?? {});
  const committed = await harnessClient.updateSession(session.id, { metadata }, { directory });
  if (committed.error || !committed.data || committed.data.id !== session.id
    || normalizeDirectory(committed.data.directory ?? directory) !== directory) {
    throw new Error('Could not update the BTW metadata');
  }
  return committed.data;
}

async function promoteLegacy(props: BtwPanelProps): Promise<void> {
  const directory = normalizeDirectory(props.directory);
  const child = await readSession(props.childSessionID, directory);
  const originalMetadata = child.metadata;
  const promoted = await patchSessionMetadata(child, directory, metadataMarkBtwPromoted);
  try {
    await unlinkParentLegacy(props.parentSessionID, directory, props.childSessionID);
  } catch {
    await patchSessionMetadata(promoted, directory, () => originalMetadata ?? {});
    throw new Error('Could not remove the BTW link');
  }
  props.onSelectSession(props.childSessionID, directory);
}

async function unlinkParentLegacy(parentID: string, directory: string, childID: string): Promise<void> {
  const parent = await readSession(parentID, directory);
  const metadata = metadataUnlinkBtwParent(parent.metadata, childID);
  if (metadata === parent.metadata) return;
  await patchSessionMetadata(parent, directory, () => metadata);
}
