// SPDX-License-Identifier: Apache-2.0
/** Durable multi-run identity. The session-org `multiRun` record is the
 * authority once it exists; the legacy title-slug parse stays the fallback
 * so sessions created before the store keep working. */
import { normalizeDirectory } from '../nnd/client.ts';
import { useSessionOrgStore } from '../../stores/useSessionOrgStore.ts';
import { parseMultiRunSessionTitle } from './title.ts';
import type { Session } from '../nnd/types.ts';

export interface MultiRunIdentity {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
  fusion: boolean;
}

export function storedMultiRunIdentity(directory: string, sessionID: string): MultiRunIdentity | undefined {
  if (typeof directory !== 'string' || directory === '' || sessionID === '') return undefined;
  const record = useSessionOrgStore.getState().recordsByDirectory[normalizeDirectory(directory)]?.[sessionID];
  const stored = record?.multiRun;
  if (!stored) return undefined;
  return {
    groupSlug: stored.groupSlug,
    ...(stored.runGroup === undefined ? {} : { runGroup: stored.runGroup }),
    providerID: stored.providerID,
    modelID: stored.modelID,
    ...(stored.index === undefined ? {} : { index: stored.index }),
    fusion: stored.fusion === true,
  };
}

/** Org record wins; the title parse stays the fallback for legacy sessions. */
export function multiRunIdentityOf(session: Pick<Session, 'id' | 'directory' | 'title'>): MultiRunIdentity | undefined {
  const stored = storedMultiRunIdentity(session.directory ?? '', session.id);
  if (stored !== undefined) return stored;
  try {
    const parsed = parseMultiRunSessionTitle(session.title ?? '');
    return {
      groupSlug: parsed.groupSlug,
      ...(parsed.runGroup === undefined ? {} : { runGroup: parsed.runGroup }),
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      ...(parsed.index === undefined ? {} : { index: parsed.index }),
      fusion: parsed.fusion === true,
    };
  } catch {
    return undefined;
  }
}
