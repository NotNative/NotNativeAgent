// SPDX-License-Identifier: Apache-2.0
/**
 * BTW state from the session-organization store. Marker presence replaces the
 * old `metadata.openchamber.kind === 'btw'` check; the metadata helpers in
 * btw-context remain only as the legacy read fallback for sessions created
 * before this store existed (mock-runtime door).
 */
import type { SessionOrgRecord } from '../lib/session-org.ts';
import { useSessionOrgStore } from '../stores/useSessionOrgStore.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { BTW_BOUNDARY_INSTRUCTION, BTW_PROMOTION_INSTRUCTION, btwRiderFor, parseBtwMetadata } from './btw-context.ts';

export interface BtwOrgState {
  active: boolean;
  promoted: boolean;
  originalSessionID?: string;
  boundaryMessageID: string | null;
}

export function parseBtwRecord(record: SessionOrgRecord | undefined): BtwOrgState {
  const marker = record?.btwMarker;
  if (!marker || typeof marker.originalSessionID !== 'string' || marker.originalSessionID === '') {
    return { active: false, promoted: false, boundaryMessageID: null };
  }
  return {
    active: true,
    promoted: marker.promoted === true,
    originalSessionID: marker.originalSessionID,
    boundaryMessageID: marker.boundaryMessageID === '' ? null : marker.boundaryMessageID,
  };
}

export function btwRiderFromRecord(record: SessionOrgRecord | undefined): { text: string; synthetic: true } | null {
  const parsed = parseBtwRecord(record);
  if (parsed.promoted) return { text: BTW_PROMOTION_INSTRUCTION, synthetic: true };
  if (parsed.active) return { text: BTW_BOUNDARY_INSTRUCTION, synthetic: true };
  return null;
}

/** Record state wins; sessions created before the store keep their metadata
 * marker as the fallback so the mock-runtime door still works. */
export function btwRiderMerged(metadata: unknown,
  record: SessionOrgRecord | undefined): { text: string; synthetic: true } | null {
  return btwRiderFromRecord(record) ?? btwRiderFor(metadata);
}

export function btwStateMerged(metadata: unknown, record: SessionOrgRecord | undefined): BtwOrgState {
  const fromRecord = parseBtwRecord(record);
  if (fromRecord.active || fromRecord.promoted) return fromRecord;
  const legacy = parseBtwMetadata(metadata);
  return legacy.active || legacy.promoted
    ? { active: legacy.active, promoted: legacy.promoted, originalSessionID: legacy.originalSessionID,
        boundaryMessageID: legacy.boundaryMessageID }
    : fromRecord;
}

/** Composer send state: rider + whether the BTW panel applies, merging the
 * org-store record with the legacy metadata marker. */
export function btwSendStateFor(directory: string, sessionID: string | null,
  metadata: unknown): { rider: { text: string; synthetic: true } | null; panelActive: boolean } {
  const record = sessionID && directory
    ? useSessionOrgStore.getState().recordsByDirectory[normalizeDirectory(directory)]?.[sessionID]
    : undefined;
  const orgLink = typeof record?.btwChildOf === 'string' && record.btwChildOf !== '';
  const legacyLink = Boolean(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    && typeof (metadata as Record<string, unknown>).openchamber === 'object'
    && (metadata as { openchamber?: Record<string, unknown> }).openchamber?.btwSessionID);
  return { rider: btwRiderMerged(metadata, record), panelActive: orgLink || legacyLink };
}
