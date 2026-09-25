// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded, safe-to-render activity evidence.  This is intentionally separate
 * from transcript parts: the harness must explicitly opt into an activity row
 * and must provide a summary suitable for an operator-facing log.
 */
import type { HarnessEvent } from '../lib/nnd/events.ts';

export interface ActivityRecord {
  id: string;
  sessionID: string;
  time: number;
  kind: 'turn' | 'tool' | 'notice';
  summary: string;
  status: 'started' | 'completed' | 'failed' | 'redacted';
  evidenceMessageID?: string;
}

export const MAX_ACTIVITY_RECORDS = 500;
export const MAX_ACTIVITY_SUMMARY_LENGTH = 4_000;
const MAX_ACTIVITY_ID_LENGTH = 264;

export function activityRecordFromEvent(event: HarnessEvent): ActivityRecord | null {
  if (event.type !== 'nnd.activity') return null;
  const props = event.properties ?? {};
  const id = stringProp(props, 'id') ?? event.id;
  const sessionID = stringProp(props, 'sessionID');
  const summary = stringProp(props, 'summary');
  const kind = stringProp(props, 'kind');
  const status = stringProp(props, 'status');
  // Reducers are replayed during reconnect and bootstrap.  A received frame
  // must therefore carry its authored timestamp rather than borrowing the
  // browser clock (which would reorder an otherwise identical replay).
  const time = numberProp(props, 'time');
  if (!id || id.length > MAX_ACTIVITY_ID_LENGTH || !sessionID || !summary || summary.length > MAX_ACTIVITY_SUMMARY_LENGTH || !isKind(kind) || !isStatus(status) || time === null || !isRenderableTime(time)) return null;
  const rawEvidence = props.evidenceMessageID;
  if (rawEvidence !== undefined && (typeof rawEvidence !== 'string' || rawEvidence.length < 1 || rawEvidence.length > 256
    || /[\u0000-\u001f\u007f]/u.test(rawEvidence) || kind !== 'turn')) return null;
  return { id, sessionID, time, kind, summary, status,
    ...(typeof rawEvidence === 'string' ? { evidenceMessageID: rawEvidence } : {}) };
}

/** Upserts corrections/redactions by stable evidence id and remains bounded. */
export function mergeActivityRecord(records: readonly ActivityRecord[], incoming: ActivityRecord): ActivityRecord[] {
  const index = records.findIndex((record) => record.id === incoming.id);
  // Event streams reconnect and may replay the same evidence frame.  Preserve
  // the existing reference for an exact replay so it cannot trigger a false UI
  // update or make a stable reader appear to have unseen activity.
  if (index !== -1 && sameActivityRecord(records[index]!, incoming)) return records as ActivityRecord[];
  const next = index === -1 ? [...records, incoming] : records.map((record, i) => i === index ? incoming : record);
  return next.length > MAX_ACTIVITY_RECORDS ? next.slice(next.length - MAX_ACTIVITY_RECORDS) : next;
}

function sameActivityRecord(left: ActivityRecord, right: ActivityRecord): boolean {
  return left.id === right.id
    && left.sessionID === right.sessionID
    && left.time === right.time
    && left.kind === right.kind
    && left.summary === right.summary
    && left.status === right.status
    && left.evidenceMessageID === right.evidenceMessageID;
}

function stringProp(props: Record<string, unknown>, key: string): string | null {
  const value = props[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function numberProp(props: Record<string, unknown>, key: string): number | null {
  const value = props[key];
  return typeof value === 'number' ? value : null;
}

function isRenderableTime(value: number): boolean {
  // ECMAScript Date rejects values outside ±8.64e15.  Rejecting those frames
  // at the trust boundary prevents an untrusted event from crashing the rail
  // while it builds the <time> value.
  return Number.isFinite(value) && Math.abs(value) <= 8.64e15;
}

function isKind(value: string | null): value is ActivityRecord['kind'] {
  return value === 'turn' || value === 'tool' || value === 'notice';
}

function isStatus(value: string | null): value is ActivityRecord['status'] {
  return value === 'started' || value === 'completed' || value === 'failed' || value === 'redacted';
}
