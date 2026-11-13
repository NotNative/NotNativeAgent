// SPDX-License-Identifier: Apache-2.0
import { newId } from '../ids.js';
import { tokenUsage } from './v2-contract.js';
import { observeForm } from './v2-forms.js';

// The durable schema version the published client declares for each tool event.
// The terminal pair was raised to 2; the opening pair rides the shared 1. The
// stream must stamp what the client expects or a strict envelope decode rejects
// the event, so this mirrors the client's own declarations rather than guessing.
const TOOL_EVENT_VERSION = {
  'session.tool.success': 2,
  'session.tool.failed': 2,
};

export function observeV1Event(state, event, events) {
  const { type, properties: value } = event;
  // Compatibility: the tool lifecycle is published verbatim by the wire session.
  // It is the only vocabulary in which the OpenChamber client renders a live
  // tool row — it declares `message.part.updated` and dispatches no case for it,
  // so without this forwarding a tool-using turn shows no tool until a reload.
  if (type.startsWith('session.tool.')) { events.emit(state, type, { ...value }, true, TOOL_EVENT_VERSION[type] ?? 1); return; }
  // Compatibility: a synthetic row is the one message the client builds from the
  // event itself — its reducer inserts a row whose id is derived from the v2
  // event id, so the same id must answer a later message read or a reload shows
  // the briefing twice. Version 1 is what the client declares for this type.
  //
  // Security: `metadata` rides the live event only. The stored row is the
  // client's `Session.Message.Synthetic`, a strict schema without a metadata
  // field, so one extra key would fail the parse of the whole history page.
  if (type === 'session.synthetic') {
    const event = events.emit(state, type, { ...value });
    const id = `msg_${String(event.id).slice(4)}`;
    state.messages.set(id, { id, sessionID: state.info.id, type: 'synthetic', text: String(value.text ?? ''),
      time: { created: event.created }, ...(typeof value.description === 'string' ? { description: value.description } : {}) });
    return;
  }
  if (type === 'nna.context.compaction') {
    // Compatibility: preserve the native v2 event envelope while keeping this
    // NNA extension outside OpenCode's standard message-part contract.
    events.emit(state, type, { ...value }, false);
    // A client announces a finished compaction from `session.compaction.ended`
    // and has no case for the extension above, so without this the compaction
    // never reaches the transcript.
    if (state.active && (value.status === 'completed' || value.status === 'failed')) {
      events.emit(state, 'session.compaction.ended', { sessionID: state.info.id }, false);
    }
    return;
  }
  if (type === 'nna.context.usage') {
    // Why preserved: the client's context pane renders the live "X% used" meter
    // from this. Why not mirrored into the transcript: it is a measurement, not
    // a message; the same exclusion the compaction extension uses.
    events.emit(state, type, { ...value }, false);
    return;
  }
  if (type.startsWith('question.')) return observeForm(state, type, value, events);
  if (type === 'message.updated') return observeMessage(state, value.info, events);
  if (type === 'message.part.updated') return observePart(state, value.part, events);
  if (type === 'message.part.delta') return observeDelta(state, value, events);
  if (type === 'session.status' && value.status.type === 'busy') {
    state.failureCode = null;
    state.running = true;
    events.emit(state, 'session.execution.started', { sessionID: state.info.id });
  }
  if (type === 'session.idle') finishExecution(state, events);
}

function observeMessage(state, info, events) {
  if (state.cancelled.has(info.id) || state.cancelled.has(info.parentID)) return;
  if (info.role === 'user') {
    if (!state.messages.has(info.id)) state.messages.set(info.id, { id: info.id, type: 'user', time: info.time, text: '' });
    return;
  }
  if (!state.messages.has(info.id)) {
    // Why non-enumerable: the message object is serialized straight to a client that
    // validates against a closed schema, so the ordering bookkeeping must live beside
    // the payload rather than inside it.
    const message = { id: info.id, type: 'assistant', agent: 'build', model: state.info.model,
      time: { created: info.time.created ?? Date.now() }, content: [] };
    Object.defineProperty(message, 'textEntries', { value: new Map(), enumerable: false });
    state.messages.set(info.id, message);
    events.emit(state, 'session.step.started', { sessionID: state.info.id, assistantMessageID: info.id,
      agent: 'build', model: state.info.model, started: info.time.created ?? Date.now() });
    const inbox = state.inbox.get(info.parentID);
    if (inbox) {
      state.inbox.delete(info.parentID);
      events.emit(state, 'session.inbox.delivered', { sessionID: state.info.id, inboxID: info.parentID });
    }
  }
  if (info.time.completed) finishMessage(state, info, events);
}

function finishMessage(state, info, events) {
  const message = state.messages.get(info.id);
  if (message.time.completed) return;
  message.time.completed = info.time.completed;
  message.finish = info.finish === 'abort' ? 'stop' : info.finish;
  message.tokens = tokenUsage(info.tokens); message.cost = info.cost ?? 0;
  state.lastOutcome = info.finish === 'abort' ? 'interrupted' : info.finish === 'error' ? 'failed' : 'succeeded';
  const data = { sessionID: state.info.id, assistantMessageID: info.id, cost: message.cost, tokens: message.tokens };
  if (info.finish === 'error') {
    message.error = failureInfo(state);
    events.emit(state, 'session.step.failed', { ...data, error: message.error });
  } else events.emit(state, 'session.step.ended', { ...data, finish: message.finish });
  for (const key of ['input', 'output', 'reasoning']) state.info.tokens[key] += message.tokens[key];
  for (const key of ['read', 'write']) state.info.tokens.cache[key] += message.tokens.cache[key];
  state.info.cost += message.cost;
}

function observePart(state, part, events) {
  // Compatibility: a tool call is a part of the assistant message. It carries the
  // tool's name and lifecycle state only — never its arguments or raw result,
  // which can hold a secret or retrieved content.
  if (part.type === 'tool') { observeToolPart(state, part); return; }
  if (part.type !== 'text') return;
  const message = state.messages.get(part.messageID);
  if (!message) return;
  if (message.type === 'user') {
    message.text = part.text;
    const input = state.inputs.get(message.id) ?? {};
    if (input.metadata) message.metadata = input.metadata;
    const item = { id: message.id, sessionID: state.info.id, time: message.time, type: 'user',
      payload: { text: part.text, ...(input.metadata ? { metadata: input.metadata } : {}) }, delivery: input.delivery ?? 'queue' };
    state.inbox.set(message.id, item);
    events.emit(state, 'session.inbox.enqueued', { sessionID: state.info.id, inboxID: message.id,
      item: { type: 'user', payload: item.payload, delivery: item.delivery } });
    return;
  }
  // Why mutate rather than rebuild: a text part is rewritten on every stream tick
  // while tool parts accumulate beside it in the same assistant message. Rebuilding
  // the array moved the prose behind every tool the turn had called, so a long turn
  // showed all its prose above a pile of tool rows instead of interleaved. Updating
  // the entry where it already sits keeps arrival order, which is what a transcript
  // reader expects.
  //
  // Why not key by part id: the v2 text part schema is closed —
  // `additionalProperties: false` — so an `id` on the payload is rejected by a
  // client that validates. The identity is tracked out of band instead.
  // Why the ordinal decides identity: the client does not read a part's `id` off
  // these events. It builds one as `${messageID}:text:${ordinal}`, so every prose
  // block sent with the same ordinal lands in the same rendered part. A turn that
  // writes prose between tool calls collapsed into one block above every tool row,
  // which is exactly the pile-up this projection already tries to avoid by giving
  // each segment its own stored part. The ordinal is the index of that segment in
  // the message, so a reload and the live stream agree on which block is which.
  const entries = message.textEntries;
  const entry = entries?.get(part.id);
  let ordinal;
  if (entry) {
    entry.text = part.text;
    ordinal = entry.ordinal;
  } else {
    const created = { type: 'text', text: part.text };
    // Why non-enumerable: the payload is validated against a closed schema, so the
    // bookkeeping must sit beside it rather than inside it.
    Object.defineProperty(created, 'ordinal', { value: entries?.size ?? 0, enumerable: false });
    ordinal = created.ordinal;
    message.content.push(created);
    entries?.set(part.id, created);
  }
  events.emit(state, part.time?.end == null ? 'session.text.started' : 'session.text.ended', {
    sessionID: state.info.id, assistantMessageID: message.id, ordinal,
    ...(part.time?.end == null ? {} : { text: part.text }),
  });
}

/** Grow the prose segment a delta belongs to.
 *
 *  Why by `partID`: a delta names the segment it continues, and a turn has
 *  several. Appending to the message's first text part put every later segment's
 *  streaming text into the block the turn opened with, so a long turn streamed one
 *  growing paragraph while its later prose segments stayed empty. */
function observeDelta(state, value, events) {
  const message = state.messages.get(value.messageID);
  if (message?.type === 'assistant') {
    const entry = message.textEntries?.get(value.partID) ?? lastTextPart(message);
    if (entry) entry.text += value.delta;
    else {
      const created = { type: 'text', text: value.delta };
      Object.defineProperty(created, 'ordinal', { value: message.textEntries?.size ?? 0, enumerable: false });
      message.content.push(created);
      message.textEntries?.set(value.partID, created);
    }
  }
  const entry = message?.type === 'assistant' ? message.textEntries?.get(value.partID) : null;
  events.emit(state, 'session.text.delta', { sessionID: state.info.id, assistantMessageID: value.messageID,
    ordinal: entry?.ordinal ?? 0, delta: value.delta }, false);
}

function lastTextPart(message) {
  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    if (message.content[index]?.type === 'text') return message.content[index];
  }
  return null;
}

/** Keep a tool part on its assistant message, in call order.
 *
 *  Security: the stored part is rebuilt from `name` and `state` only. A tool's
 *  input can contain a secret and its output can contain retrieved content that
 *  must not gain authority, so neither is copied.
 *
 *  Why replace by id: one call reports several lifecycle records, and the
 *  transcript should show one row whose state changes, not a row per record. */
function observeToolPart(state, part) {
  const message = state.messages.get(part.messageID);
  if (!message || message.type !== 'assistant') return;
  const stored = { type: 'tool', id: part.id, name: part.name, state: part.state, time: part.time };
  const index = message.content.findIndex((item) => item.type === 'tool' && item.id === part.id);
  if (index >= 0) message.content[index] = stored; else message.content.push(stored);
}

function finishExecution(state, events) {  state.running = false;
  state.info.outcome = state.lastOutcome ?? 'succeeded';
  state.info.time.idle = Date.now(); state.info.time.updated = state.info.time.idle;
  // Compatibility: OpenCode 2 writes an `idle` record into the session's message
  // list when a turn ends, and a client walks that list newest-first to find
  // where the running turn began. The v1 ledger carries its own marker; this is
  // the marker the v2 message read returns.
  recordIdle(state);
  const extra = state.info.outcome === 'interrupted' ? { reason: 'user' }
    : state.info.outcome === 'failed' ? { error: failureInfo(state) } : {};
  events.emit(state, `session.execution.${state.info.outcome}`, { sessionID: state.info.id, ...extra });
  // Compatibility: v2 clients end a turn from `session.error`, which also
  // settles a status a client would otherwise keep as busy. The payload is the
  // same fixed guidance the execution event carries, never provider text.
  if (state.info.outcome === 'failed') {
    events.emit(state, 'session.error', { sessionID: state.info.id, error: extra.error });
  }
  events.emit(state, 'session.usage.updated', { sessionID: state.info.id, cost: state.info.cost, tokens: state.info.tokens }, false);
}

/** Add the turn's closing marker once, in order, with the outcome it settled. */
function recordIdle(state) {
  const id = newId('msg');
  state.messages.set(id, {
    id, sessionID: state.info.id, type: 'idle',
    outcome: state.info.outcome === 'interrupted' ? 'interrupted'
      : state.info.outcome === 'failed' ? 'failed' : 'succeeded',
    time: { created: state.info.time.idle },
  });
  state.idleRecord = id;
}

function failureInfo(state) {
  // Security: only fixed credential guidance crosses the wire; provider exception text can contain secrets.
  const credentialFailures = new Set(['missing_credential', 'secret_not_found', 'secret_revoked', 'secret_field_not_found']);
  if (credentialFailures.has(state.failureCode)) return { type: state.failureCode,
    message: 'The provider credential is unavailable. Connect an API key for this provider in OpenChamber settings.' };
  return { type: 'nna_execution_failed', message: 'NNA could not complete the turn' };
}
