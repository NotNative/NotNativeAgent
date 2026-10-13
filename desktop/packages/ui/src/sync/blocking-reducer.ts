// SPDX-License-Identifier: Apache-2.0
/**
 * Blocking-request reducer (doc 04 §B.2): permission.asked/replied and
 * question.asked/replied/rejected. Bucket upsert keeps id-sorted order;
 * remove is deterministic; empty buckets drop their key.
 */
import type { HarnessEvent } from '../lib/nnd/events.ts';
import type { PermissionRequest, QuestionRequest } from '../lib/nnd/types.ts';
import type { SyncState } from './types.ts';
import { loose } from './reducer-core.ts';
import type { ReducerApi } from './reducer-core.ts';
import { removeById, upsertById } from './event-equality.ts';

/** Handles blocking-request events; returns true when the type was owned. */
export function applyBlockingEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): boolean {
  switch (event.type) {
    case 'permission.asked':
      askRequest(draft, api, loose(event.properties) as unknown as PermissionRequest, 'permission');
      return true;
    case 'permission.replied':
      replyRequest(draft, api, loose(event.properties), 'permission');
      return true;
    case 'question.asked':
      askRequest(draft, api, loose(event.properties) as unknown as QuestionRequest, 'question');
      return true;
    case 'question.replied':
    case 'question.rejected':
      replyRequest(draft, api, loose(event.properties), 'question');
      return true;
    default:
      return false;
  }
}

type BucketKey = 'permission' | 'question';
type Requested = PermissionRequest | QuestionRequest;

function askRequest(
  draft: SyncState,
  api: ReducerApi,
  request: Requested,
  key: BucketKey,
): void {
  const sessionID = (request.sessionID ?? loose(request)['sessionId']) as string | undefined;
  if (!sessionID || !request?.id) return;
  const existing = bucketsOf(draft, key)[sessionID] ?? [];
  const prior = existing.find((item) => item.id === request.id);
  if (prior && JSON.stringify(prior) === JSON.stringify(request)) return;
  api.ensure(key);
  const bucket = [...existing];
  upsertById(bucket as Requested[], request);
  bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  writeBuckets(draft, key, sessionID, bucket);
  if (!prior) {
    if (key === 'permission') api.out.permissionAsks.push({ sessionID, request: request as PermissionRequest });
    else api.out.questionAsks.push({ sessionID, request: request as QuestionRequest });
  }
  api.changed();
}

function replyRequest(draft: SyncState, api: ReducerApi, props: Record<string, unknown>, key: BucketKey): void {
  const sessionID = (props['sessionID'] ?? props['sessionId']) as string | undefined;
  const requestID = props['requestID'] as string | undefined;
  if (!sessionID || !requestID) return;
  api.out[key === 'permission' ? 'permissionReplies' : 'questionSettled'].push({ sessionID, requestID });
  const existing = bucketsOf(draft, key)[sessionID];
  if (!existing || !existing.some((item) => item.id === requestID)) return;
  api.ensure(key);
  const bucket = [...existing];
  if (!removeById(bucket, requestID)) return;
  writeBuckets(draft, key, sessionID, bucket);
  api.changed();
}

function bucketsOf(draft: SyncState, key: BucketKey): Record<string, Requested[]> {
  return key === 'permission' ? draft.permission : draft.question;
}

function writeBuckets(draft: SyncState, key: BucketKey, sessionID: string, bucket: Requested[]): void {
  const empty = bucket.length === 0;
  if (key === 'permission') {
    const next = { ...draft.permission };
    if (empty) delete next[sessionID];
    else next[sessionID] = bucket as PermissionRequest[];
    draft.permission = next;
    return;
  }
  const next = { ...draft.question };
  if (empty) delete next[sessionID];
  else next[sessionID] = bucket as QuestionRequest[];
  draft.question = next;
}
