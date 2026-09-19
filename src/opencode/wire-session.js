// SPDX-License-Identifier: Apache-2.0
// Per-session OpenCode wire voice: turn cadence on /global/event, the wire
// id/part ledger that message synthesis reads back, and the prompt queue
// chain. Gold-observed OC semantics live here: prompts while busy queue
// (never reject), durable events pair with a `sync` mirror carrying the same
// event id and a per-session monotonic seq, while status/idle/diff/delta
// frames ride bare; the sync prompt response resolves after the turn closes.
import { ContractError, newId } from '../ids.js';
import { createHash } from 'node:crypto';

const QUEUE_LIMIT = 64;
const MAX_PROMPT_PARTS = 128;
const MAX_PART_TEXT = 65_536;
const ZERO_TOKENS = Object.freeze({ total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

export function createWireSession({ record, bus, info, version }) {
  const state = {
    sessionID: record.ocId,
    directory: record.directory ?? '',
    project: record.projectID ?? '',
    version,
    snapshot: snapshotValue(record.directory ?? ''),
    modelRef: { providerID: 'nna', modelID: 'nna' },
    ledger: [],
    bus,
    info,
    record,
    seq: 0,
    active: null,
    tail: Promise.resolve(),
  };
  return {
    setModelRef(next) { applyModelRef(state, next); },
    observe(record) { observeEngineRecord(state, record); },
    prompt(parts) { return prompt(state, parts); },
    messages() { return messagesFromLedger(state); },
    pendingCount() { return state.ledger.filter((entry) => entry.response === null).length; },
  };
}

function applyModelRef(state, next) {
  if (typeof next?.providerID === 'string' && next.providerID) state.modelRef.providerID = next.providerID;
  if (typeof next?.modelID === 'string' && next.modelID) state.modelRef.modelID = next.modelID;
}

function observeEngineRecord(state, record) {
  if (record?.type === 'stream_delta' && state.active) {
    publishBare(state, 'message.part.delta', {
      sessionID: state.sessionID, messageID: state.active.assistantId, partID: state.active.textPartId,
      field: 'text', delta: record.text ?? '',
    });
    if (state.active.deltaStart === null) state.active.deltaStart = Date.now();
  }
}

function prompt(state, parts) {
  const text = buildPromptCommand(parts);
  if (state.ledger.length >= QUEUE_LIMIT) {
    throw new ContractError('opencode_prompt_queue_overflow', 'prompt queue is full');
  }
  const entry = createEntry(state, text);
  state.ledger.push(entry);
  // Why: gold OC opens a fresh session's first prompt with a session.updated
  // pair, but later prompts emit the user message first (ledger lifecycle,
  // not run timing, pins the first-seen event order per stream).
  if (state.ledger.length === 1) emitFirstAdmission(state, entry);
  else emitFollowAdmission(state, entry);
  const bound = state.tail.then(() => runEntry(state, entry));
  state.tail = bound.catch(() => {});
  return bound;
}

async function runEntry(state, entry) {
  state.active = entry;
  entry.assistantCreated = entry.createdAt;
  entry.textStart = Date.now();
  emitTurnStarted(state, entry);
  try {
    const result = await state.record.ingress.submit(
      { type: 'submit', request_id: entry.requestId, content: entry.text, version: '1.0' }, 'opencode-wire',
    );
    entry.response = settleEntry(state, entry, result);
    return entry.response;
  } catch (error) {
    entry.response = settleFailure(state, entry);
    throw error;
  } finally {
    closeTurn(state, entry);
    state.active = null;
  }
}

function emitFirstAdmission(state, entry) {
  entry.createdAt = Date.now();
  publishDurable(state, 'session.updated', { sessionID: state.sessionID, info: currentInfo(state) });
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: userInfo(state, entry) });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: userPart(state, entry), time: entry.createdAt });
  publishDurable(state, 'session.updated', { sessionID: state.sessionID, info: currentInfo(state) });
}

function emitFollowAdmission(state, entry) {
  entry.createdAt = Date.now();
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: userInfo(state, entry) });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: userPart(state, entry), time: entry.createdAt });
  publishDurable(state, 'session.updated', { sessionID: state.sessionID, info: currentInfo(state) });
}

function emitTurnStarted(state, entry) {
  const nowMs = Date.now();
  publishBare(state, 'session.status', { sessionID: state.sessionID, status: { type: 'busy' } });
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: assistantInfo(state, entry) });
  publishDurable(state, 'session.updated', { sessionID: state.sessionID, info: currentInfo(state) });
  publishBare(state, 'session.diff', { sessionID: state.sessionID, diff: [] });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepStartPart(state, entry), time: nowMs });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: textPartOpen(state, entry), time: nowMs });
}

function settleEntry(state, entry, result) {
  const nowMs = Date.now();
  entry.assistantContent = typeof result?.text === 'string' ? result.text : '';
  entry.textEnded = nowMs;
  entry.assistantCompleted = nowMs;
  entry.tokens = tokenView(result?.usage);
  entry.finish = result?.outcome === 'completed' ? 'stop' : 'error';
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: textPartFinal(state, entry), time: nowMs });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepFinishPart(state, entry), time: nowMs });
  const response = buildAssistantResponse(state, entry);
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: response.info });
  return response;
}

function settleFailure(state, entry) {
  const nowMs = Date.now();
  entry.assistantContent = '';
  entry.textEnded = nowMs;
  entry.assistantCompleted = nowMs;
  entry.tokens = ZERO_TOKENS;
  entry.finish = 'error';
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: textPartFinal(state, entry), time: nowMs });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepFinishPart(state, entry), time: nowMs });
  const response = buildAssistantResponse(state, entry);
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: response.info });
  return response;
}

function closeTurn(state, entry) {
  publishBare(state, 'session.status', { sessionID: state.sessionID, status: { type: 'idle' } });
  publishBare(state, 'session.idle', { sessionID: state.sessionID });
  publishDurable(state, 'session.updated', { sessionID: state.sessionID, info: currentInfo(state) });
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: closedUserInfo(state, entry) });
  entry.closedAt = Date.now();
}

function publishDurable(state, type, properties) {
  state.seq += 1;
  state.bus.publishSession({ directory: state.directory, project: state.project, sessionID: state.sessionID, type, properties, mirror: true, seq: state.seq });
}

function publishBare(state, type, properties) {
  state.bus.publishSession({ directory: state.directory, project: state.project, sessionID: state.sessionID, type, properties });
}

function currentInfo(state) { return state.info(); }

function createEntry(state, text) {
  return {
    requestId: newId('oc_prompt'), text,
    userMessageId: newId('msg'), userPartId: newId('prt'),
    assistantId: newId('msg'), stepStartId: newId('prt'), textPartId: newId('prt'), stepFinishId: newId('prt'),
    createdAt: Date.now(), assistantCreated: null, assistantCompleted: null,
    textStart: null, textEnded: null, deltaStart: null, closedAt: null,
    assistantContent: '', finish: null, tokens: ZERO_TOKENS, response: null,
  };
}

function buildAssistantResponse(state, entry) {
  return {
    info: assistantInfo(state, entry, { completed: entry.assistantCompleted, finish: entry.finish ?? 'error' }),
    parts: [stepStartPart(state, entry), textPartFinal(state, entry), stepFinishPart(state, entry)],
  };
}

function messagesFromLedger(state) {
  const messages = [];
  for (const entry of state.ledger) {
    messages.push({ info: closedUserInfo(state, entry), parts: [userPart(state, entry)] });
    if (entry.response !== null) messages.push({ info: entry.response.info, parts: entry.response.parts });
  }
  return messages;
}

function closedUserInfo(state, entry) {
  return { ...userInfo(state, entry), summary: { diffs: [] } };
}

function userInfo(state, entry) {
  return {
    id: entry.userMessageId, role: 'user', sessionID: state.sessionID,
    time: { created: entry.createdAt }, agent: 'build',
    model: { providerID: state.modelRef.providerID, modelID: state.modelRef.modelID },
  };
}

function assistantInfo(state, entry, extra = {}) {
  const complete = Boolean(extra.completed);
  return {
    id: entry.assistantId, parentID: entry.userMessageId, role: 'assistant', mode: 'build', agent: 'build',
    path: { cwd: state.directory, root: state.directory }, cost: 0,
    tokens: complete ? (entry.tokens ?? ZERO_TOKENS) : ZERO_TOKENS,
    modelID: state.modelRef.modelID, providerID: state.modelRef.providerID,
    time: { created: entry.assistantCreated, ...(complete ? { completed: extra.completed } : {}) },
    ...(extra.finish ? { finish: extra.finish } : {}),
    sessionID: state.sessionID,
  };
}

function userPart(state, entry) {
  return { type: 'text', text: entry.text, messageID: entry.userMessageId, sessionID: state.sessionID, id: entry.userPartId };
}

function stepStartPart(state, entry) {
  return { id: entry.stepStartId, messageID: entry.assistantId, sessionID: state.sessionID, snapshot: state.snapshot, type: 'step-start' };
}

function textPartOpen(state, entry) {
  return { id: entry.textPartId, messageID: entry.assistantId, sessionID: state.sessionID, type: 'text', text: '', time: { start: entry.textStart } };
}

function textPartFinal(state, entry) {
  return { id: entry.textPartId, messageID: entry.assistantId, sessionID: state.sessionID, type: 'text', text: entry.assistantContent, time: { start: entry.textStart, end: entry.textEnded ?? entry.textStart } };
}

function stepFinishPart(state, entry) {
  return { id: entry.stepFinishId, messageID: entry.assistantId, sessionID: state.sessionID, reason: entry.finish ?? 'stop', snapshot: state.snapshot, type: 'step-finish', cost: 0, tokens: entry.tokens ?? ZERO_TOKENS };
}

export function buildPromptCommand(parts, limits = {}) {
  return composePromptText(parts, limits);
}

function composePromptText(parts, limits) {
  const maxParts = limits.maxParts ?? MAX_PROMPT_PARTS;
  const maxText = limits.maxText ?? MAX_PART_TEXT;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new ContractError('opencode_prompt_parts_invalid', 'prompt requires at least one text part');
  }
  if (parts.length > maxParts) throw new ContractError('opencode_prompt_parts_invalid', 'prompt exceeds part bounds');
  const texts = [];
  for (const part of parts) {
    texts.push(requireTextPart(part, maxText));
  }
  return texts.join('\n');
}

function requireTextPart(part, maxText) {
  if (!part || typeof part !== 'object' || part.type !== 'text') {
    throw new ContractError('opencode_prompt_parts_unsupported', 'only text prompt parts are accepted');
  }
  if (typeof part.text !== 'string' || part.text.length === 0) {
    throw new ContractError('opencode_prompt_parts_invalid', 'text prompt parts require text');
  }
  if (part.text.length > maxText) throw new ContractError('opencode_prompt_parts_invalid', 'prompt text exceeds bounds');
  return part.text;
}

export function tokenView(usage = {}) {
  const input = Number(usage?.prompt_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? 0);
  return { total: Number(usage?.total_tokens ?? input + output), input, output, reasoning: 0, cache: { read: 0, write: 0 } };
}

export function snapshotValue(directory) {
  return createHash('sha256').update(String(directory)).digest('hex').slice(0, 40);
}
