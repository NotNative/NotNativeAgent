// SPDX-License-Identifier: Apache-2.0
/** A read-only durable suffix. These rows must never be merged into the live SSE store. */
import { harnessClient } from '../lib/nnd/client.ts';
import { activityRecordFromEvent, type ActivityRecord } from './activity-log.ts';

export interface DurableActivityPage {
  status: 'page' | 'gap';
  reason: 'snapshot_changed' | 'session_recreated' | null;
  snapshot: {
    digest: string; createdAt: number; durablePresent: boolean; retainedCount: number;
    retentionLimit: number; retainedLowerBound: string | null; retainedUpperBound: string | null;
  };
  records: ActivityRecord[];
  nextCursor: string | null;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedID = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 264
  && !/[\u0000-\u001f\u007f]/u.test(value);

export function parseDurableActivityPage(value: unknown, sessionID: string): DurableActivityPage | null {
  if (!object(value) || !object(value.snapshot) || !Array.isArray(value.records)) return null;
  const snap = value.snapshot;
  if (value.status !== 'page' && value.status !== 'gap' || snap.version !== 1 || snap.sessionID !== sessionID
    || !Number.isSafeInteger(snap.createdAt) || Number(snap.createdAt) < 1
    || typeof snap.digest !== 'string' || !/^[0-9a-f]{64}$/u.test(snap.digest)
    || typeof snap.durablePresent !== 'boolean' || !Number.isSafeInteger(snap.retainedCount)
    || Number(snap.retainedCount) < 0 || Number(snap.retainedCount) > 500
    || snap.retentionLimit !== 500 || snap.historyComplete !== false
    || (snap.retainedLowerBound !== null && !boundedID(snap.retainedLowerBound))
    || (snap.retainedUpperBound !== null && !boundedID(snap.retainedUpperBound))
    || (Number(snap.retainedCount) === 0) !== (snap.retainedLowerBound === null && snap.retainedUpperBound === null)
    || (!snap.durablePresent && Number(snap.retainedCount) !== 0)) return null;
  const gap = value.status === 'gap';
  if (gap && (value.reason !== 'snapshot_changed' && value.reason !== 'session_recreated'
    || value.records.length !== 0 || value.nextCursor !== null)) return null;
  if (!gap && (value.reason !== undefined || value.records.length > 50
    || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || value.nextCursor.length < 1 || value.nextCursor.length > 768)
    || value.records.length > Number(snap.retainedCount)
    || value.records.length === 0 && value.nextCursor !== null)) return null;
  const records: ActivityRecord[] = [];
  const seen = new Set<string>();
  for (const row of value.records) {
    if (!object(row)) return null;
    // The native disk schema permits an empty sanitized summary. The live-event
    // parser requires a nonempty summary, so supply a display-only placeholder.
    const record = activityRecordFromEvent({ type: 'nnd.activity', properties: {
      ...row, summary: row.summary === '' ? 'No summary saved' : row.summary,
    } });
    if (!record || record.sessionID !== sessionID || seen.has(record.id)) return null;
    seen.add(record.id);
    records.push(record);
  }
  return { status: gap ? 'gap' : 'page', reason: gap ? value.reason as DurableActivityPage['reason'] : null,
    snapshot: { digest: snap.digest, createdAt: Number(snap.createdAt), durablePresent: snap.durablePresent,
      retainedCount: Number(snap.retainedCount), retentionLimit: 500,
      retainedLowerBound: snap.retainedLowerBound as string | null,
      retainedUpperBound: snap.retainedUpperBound as string | null },
    records, nextCursor: value.nextCursor as string | null };
}

export async function readDurableActivityPage(sessionID: string, cursor?: string): Promise<DurableActivityPage> {
  const result = await harnessClient.readActivityHistoryPage(sessionID, cursor);
  if (result.error) throw new Error(result.error);
  const page = parseDurableActivityPage(result.data, sessionID);
  if (!page) throw new Error('Native saved Activity response is invalid');
  return page;
}
