// SPDX-License-Identifier: Apache-2.0
/**
 * Transcript reducer (doc 04 §B.2): message.updated/removed and the
 * message.part.* family. Handles chronology ordering, terminal tool part
 * preservation, snapshot-after-delta dedupe flags, optimistic part replacement
 * in place, and missing-owner materialization results.
 */
import type { HarnessEvent } from '../lib/nnd/events.ts';
import type { Message, Part } from '../lib/nnd/types.ts';
import type { SyncState } from './types.ts';
import type { MaterializationRequest } from './types.ts';
import {
  areMessageUpdateFieldsEqual,
  appendNonOverlappingDelta,
  getUpdatedDeltaFields,
  shouldPreserveExistingPart,
} from './event-equality.ts';
import { compareMessagesChronological, insertMessageChronological, removeMessageById } from './message-ordering.ts';
import { loose, notePartChanged, SKIP_PART_TYPES } from './reducer-core.ts';
import type { ReducerApi } from './reducer-core.ts';

/** Handles transcript events; returns true when the type was owned. */
export function applyTranscriptEvent(draft: SyncState, event: HarnessEvent, api: ReducerApi): boolean {
  switch (event.type) {
    case 'message.updated':
      applyMessageUpdated(draft, event, api);
      return true;
    case 'message.removed':
      applyMessageRemoved(draft, event, api);
      return true;
    case 'message.part.updated':
      applyPartUpdated(draft, event, api);
      return true;
    case 'message.part.removed':
      applyPartRemoved(draft, event, api);
      return true;
    case 'message.part.delta':
      applyPartDelta(draft, event, api);
      return true;
    default:
      return false;
  }
}

function applyMessageUpdated(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const info = loose(event.properties)['info'] as Message | undefined;
  if (!info?.id || !info.sessionID) return;
  const bucket = draft.message[info.sessionID];
  const index = bucket ? bucket.findIndex((m) => m.id === info.id) : -1;
  if (index >= 0 && bucket && areMessageUpdateFieldsEqual(bucket[index]!, info)) return;
  api.ensure('message');
  const target = draft.message[info.sessionID];
  if (!target) {
    draft.message[info.sessionID] = [info];
    noteAssistantInsert(api, info);
    return;
  }
  const at = target.findIndex((m) => m.id === info.id);
  if (at < 0) {
    insertMessageChronological(target, info);
    noteAssistantInsert(api, info);
    return;
  }
  const merged = { ...info } as Message;
  if (loose(info.time)['completed'] !== undefined) noteMessageCompleted(api, info.sessionID, info.id);
  if (compareMessagesChronological(target[at]!, merged) === 0) target[at] = merged;
  else {
    target.splice(at, 1);
    insertMessageChronological(target, merged);
  }
  api.out.messageRoutes.push({ messageID: info.id, sessionID: info.sessionID });
}

function noteAssistantInsert(api: ReducerApi, info: Message): void {
  if (info.role === 'assistant') {
    api.out.materializations.push({ reason: 'empty-assistant-message', sessionID: info.sessionID, messageID: info.id });
  }
  api.out.messageRoutes.push({ messageID: info.id, sessionID: info.sessionID });
  api.changed();
}

function noteMessageCompleted(api: ReducerApi, sessionID: string, messageID: string): void {
  api.out.messageCompleted.push({ sessionID, messageID });
}

function applyMessageRemoved(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const sessionID = props['sessionID'] as string | undefined;
  const messageID = props['messageID'] as string | undefined;
  if (!sessionID || !messageID) return;
  const bucket = draft.message[sessionID];
  const partBucket = draft.part[messageID];
  const has = bucket ? bucket.some((m) => m.id === messageID) : false;
  if (!has && !partBucket) return;
  api.ensure('message');
  api.ensure('part');
  if (draft.message[sessionID]) removeMessageById(draft.message[sessionID]!, messageID);
  delete draft.part[messageID];
  api.changed();
}

function applyPartUpdated(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const part = loose(event.properties)['part'] as Part | undefined;
  if (!part?.id || !part.messageID) return;
  if (SKIP_PART_TYPES.has(part.type)) return;
  const bucket = draft.part[part.messageID];
  const index = bucket ? bucket.findIndex((p) => p.id === part.id) : -1;
  if (index >= 0 && shouldPreserveExistingPart(bucket![index], part)) return;
  const previous = index >= 0 ? bucket![index] : undefined;
  api.ensure('part');
  const target = draft.part[part.messageID];
  if (!target) {
    draft.part[part.messageID] = [part];
    notePartChanged(api.out, part.messageID);
    missingOwnerCheck(draft, part, event, api.out);
    api.changed();
    return;
  }
  const at = target.findIndex((p) => p.id === part.id);
  if (at >= 0) {
    const fields = getUpdatedDeltaFields(previous, part);
    const next = { ...part } as Record<string, unknown>;
    if (fields.length) next['__dedupeNextDeltaFields'] = fields;
    target[at] = next as Part;
    notePartChanged(api.out, part.messageID);
    api.changed();
    return;
  }
  applyNewPart(draft, target, part, event, api);
}

function applyNewPart(draft: SyncState, target: Part[], part: Part, event: HarnessEvent, api: ReducerApi): void {
  let replaced = false;
  if (part.type === 'text' || part.type === 'file') {
    // optimistic (sessionID-less) same-type part is replaced IN PLACE, not pushed
    const optimisticIndex = target.findIndex((p) => p.type === part.type && !p.sessionID);
    if (optimisticIndex >= 0) {
      target[optimisticIndex] = part;
      replaced = true;
    }
  }
  if (!replaced) target.push(part);
  notePartChanged(api.out, part.messageID);
  missingOwnerCheck(draft, part, event, api.out);
  api.changed();
}

function applyPartRemoved(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const messageID = props['messageID'] as string | undefined;
  const partID = props['partID'] as string | undefined;
  if (!messageID || !partID) return;
  const bucket = draft.part[messageID];
  if (!bucket) return;
  const index = bucket.findIndex((p) => p.id === partID);
  if (index < 0) return;
  api.ensure('part');
  bucket.splice(index, 1);
  if (bucket.length === 0) delete draft.part[messageID];
  notePartChanged(api.out, messageID);
  api.changed();
}

function applyPartDelta(draft: SyncState, event: HarnessEvent, api: ReducerApi): void {
  const props = loose(event.properties);
  const messageID = props['messageID'] as string | undefined;
  const partID = props['partID'] as string | undefined;
  const field = props['field'] as string | undefined;
  const delta = props['delta'] as string | undefined;
  const sessionID = props['sessionID'] as string | undefined;
  if (!messageID || !partID || !field || typeof delta !== 'string') return;
  api.ensure('part');
  const bucket = draft.part[messageID];
  const partIndex = bucket ? bucket.findIndex((p) => p.id === partID) : -1;
  if (!bucket || partIndex < 0) {
    pushDeltaMaterialization(api, sessionID, messageID, bucket, sessionID ? draft.message[sessionID] : undefined);
    return;
  }
  const next = applyDeltaToPart(bucket[partIndex]!, field, delta);
  bucket[partIndex] = next;
  notePartChanged(api.out, messageID);
  if (sessionID) api.out.messageRoutes.push({ messageID, sessionID });
  api.changed();
}

function pushDeltaMaterialization(
  api: ReducerApi,
  sessionID: string | undefined,
  messageID: string,
  bucket: Part[] | undefined,
  messages: Message[] | undefined,
): void {
  const orphan = !bucket || (sessionID ? messages === undefined : true);
  const request: MaterializationRequest = {
    reason: orphan ? 'orphan-delta' : 'missing-delta-part',
    sessionID: sessionID ?? '',
    messageID,
  };
  api.out.materializations.push(request);
}

function applyDeltaToPart(part: Part, field: string, delta: string): Part {
  const next = { ...part } as LoosePart;
  const dedupe = (next.__dedupeNextDeltaFields as string[] | undefined) ?? undefined;
  const current = readDeltaField(next, field);
  const append = dedupe?.includes(field)
    ? appendNonOverlappingDelta(current, delta)
    : current + delta;
  if (dedupe?.includes(field)) {
    const remaining = dedupe.filter((name) => name !== field);
    if (remaining.length === 0) delete next.__dedupeNextDeltaFields;
    else next.__dedupeNextDeltaFields = remaining;
  }
  writeDeltaField(next, field, append);
  return next as unknown as Part;
}

type LoosePart = { [key: string]: unknown; state?: Record<string, unknown>; __dedupeNextDeltaFields?: string[] };

function readDeltaField(part: LoosePart, field: string): string {
  if (field === 'output') {
    const state = part.state ?? {};
    return typeof state['output'] === 'string' ? state['output'] as string : '';
  }
  return typeof part[field] === 'string' ? part[field] as string : '';
}

function writeDeltaField(part: LoosePart, field: string, value: string): void {
  if (field === 'output') {
    const state = { ...part.state };
    state['output'] = value;
    part.state = state;
    return;
  }
  part[field] = value;
}

function missingOwnerCheck(draft: SyncState, part: Part, event: HarnessEvent, out: MaterializationSink): void {
  const sessionID = (loose(event.properties)['sessionID'] as string | undefined) ?? part.sessionID;
  if (!sessionID) return;
  const messages = draft.message[sessionID];
  if (!messages || !messages.some((m) => m.id === part.messageID)) {
    out.materializations.push({ reason: 'missing-owning-message', sessionID, messageID: part.messageID });
  }
}

interface MaterializationSink {
  materializations: MaterializationRequest[];
}
