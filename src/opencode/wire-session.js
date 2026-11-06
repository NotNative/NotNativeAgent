// SPDX-License-Identifier: Apache-2.0
// Per-session OpenCode wire voice: turn cadence on /global/event, the wire
// id/part ledger that message synthesis reads back, and the prompt queue
// chain. Gold-observed OC semantics live here: prompts while busy queue
// (never reject), durable events pair with a `sync` mirror carrying the same
// event id and a per-session monotonic seq, while status/idle/diff/delta
// frames ride bare; the sync prompt response resolves after the turn closes.
import { ContractError, newId } from '../ids.js';
import { createHash } from 'node:crypto';
import { physicalWireAllowance } from '../reliability/context-budget.js';
import { PROTOCOL_TOOL_NAMES } from '../tools/core-names.js';

const QUEUE_LIMIT = 64;
const HISTORY_LIMIT = 64;
const MAX_PROMPT_PARTS = 128;
const DEFAULT_PART_TEXT_ALLOWANCE = physicalWireAllowance(65_536);
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
    // Why: the engine journals a prompt under its own `request_id` (oc_prompt_*)
    // while the client addresses a turn by the message id it supplied (msg_*).
    // Revert resolves a boundary by engine request id, so this map is the join
    // between the two. It is bounded by the ledger, which already caps history.
    requestIdByMessage: new Map(),
  };
  return {
    setModelRef(next) { applyModelRef(state, next); },
    observe(record) { observeEngineRecord(state, record); },
    // Resolve the engine request id a wire message id was admitted under.
    requestIdFor(messageID) { return state.requestIdByMessage.get(messageID) ?? null; },
    prompt(parts) { return admit(state, parts).response; },
    admit(parts, input = {}) { return admit(state, parts, input); },
    abort() { return abortPending(state); },
    messages() { return messagesFromLedger(state); },
    pendingCount() { return pendingCount(state); },
  };
}

function applyModelRef(state, next) {
  if (typeof next?.providerID === 'string' && next.providerID) state.modelRef.providerID = next.providerID;
  if (typeof next?.modelID === 'string' && next.modelID) state.modelRef.modelID = next.modelID;
}

function observeEngineRecord(state, record) {
  if (record?.type === 'context_compaction_status' && state.active) {
    // Compatibility: OpenCode has no standard compaction part. Emit a scoped
    // extension event without inserting diagnostic text into the assistant answer.
    publishBare(state, 'nna.context.compaction', {
      sessionID: state.sessionID, turnID: record.turn_id ?? null,
      status: record.status, trigger: record.trigger ?? null,
      reasonCode: record.reason_code ?? null,
      beforeEstimatedTokens: record.before_estimated_tokens ?? null,
      afterEstimatedTokens: record.after_estimated_tokens ?? null,
      targetTokens: record.target_tokens ?? null,
      contextWindowTokens: record.context_window_tokens ?? null,
      inputGrowthTokens: record.input_growth_tokens ?? null,
    });
    // Compatibility: a v2 client announces a finished compaction from
    // `session.compaction.ended` and has no case for the NNA extension above, so
    // a compaction would otherwise never reach the transcript. Only a settled
    // compaction is announced; a skipped or in-flight one did not compact.
    if (record.status === 'completed' || record.status === 'failed') {
      publishBare(state, 'session.compaction.ended', { sessionID: state.sessionID });
    }
    return;
  }
  if (record?.type === 'stream_delta' && state.active) {
    publishBare(state, 'message.part.delta', {
      sessionID: state.sessionID, messageID: state.active.assistantId, partID: state.active.textPartId,
      field: 'text', delta: record.text ?? '',
    });
    if (state.active.deltaStart === null) state.active.deltaStart = Date.now();
    return;
  }
  if (record?.type === 'tool_status' && state.active) observeToolStatus(state, record);
  // Why: NNA waits out a provider outage before retrying. Without a wire signal
  // the client shows a bare busy status with no explanation, so an operator
  // cannot tell a stalled turn from a recovering one.
  if (record?.type === 'state_status' && state.active && record.semantic_state === 'recovering'
    && state.active.retryAnnounced !== true) {
    state.active.retryAnnounced = true;
    publishBare(state, 'session.retry.scheduled', {
      sessionID: state.sessionID,
      attempt: null,
      error: { message: 'The provider is unavailable. NNA is waiting before it retries.' },
    });
  }
}

// Why: a v2 transcript shows tool calls as parts of the assistant message. The
// engine already reports each tool's name and lifecycle, so the wire projects
// that into the tool state a client renders.
//
// Security: tool rows carry the tool name and its state only. Arguments and raw
// results stay with the engine; a tool's input can contain a secret and its
// output can contain retrieved content that must not gain authority.
const RUNNING_TOOL_STATES = new Set(['review_pending', 'approved', 'running']);

function observeToolStatus(state, record) {
  if (typeof record.tool !== 'string' || !record.tool) return;
  // Why: a protocol tool declares turn control instead of doing visible work,
  // and OpenCode has no call to show for it. Rendering it would invent a tool
  // step the model never performed.
  if (PROTOCOL_TOOL_NAMES.includes(record.tool)) return;
  const key = record.tool_request_id ?? record.provider_call_id ?? record.tool;
  const nowMs = Date.now();
  let part = state.active.toolParts.get(key);
  if (!part) {
    part = { id: newId('prt'), messageID: state.active.assistantId, sessionID: state.sessionID,
      type: 'tool', name: record.tool, time: { created: nowMs }, state: null };
    state.active.toolParts.set(key, part);
  }
  const status = record.status;
  part.state = RUNNING_TOOL_STATES.has(status)
    ? { status: 'running', input: {}, metadata: {} }
    : status === 'succeeded'
      ? { status: 'completed', input: {}, content: [{ type: 'text', text: '' }] }
      : { status: 'error', input: {}, error: { type: 'nna_tool_failed',
        message: 'The tool did not complete. NNA records the reason in its own journal.' } };
  if (part.state.status === 'running') part.time.ran = nowMs; else part.time.completed = nowMs;
  // Compatibility: the part is projected on the assistant message so a client
  // that rebuilds the transcript from parts renders the call in place.
  const assistant = state.active.assistantParts ?? [];
  const existing = assistant.findIndex((item) => item.id === part.id);
  if (existing >= 0) assistant[existing] = part; else assistant.push(part);
}

function admit(state, parts, input = {}) {
  const text = buildPromptCommand(parts, { maxText: physicalWireAllowance(
    state.record.engine?.ingressContextWindowTokens ?? state.record.engine?.lastContextMeasurement?.windowTokens ?? 65_536,
  ) });
  if (pendingCount(state) >= QUEUE_LIMIT) {
    throw new ContractError('opencode_prompt_queue_overflow', 'prompt queue is full');
  }
  // Invariant: queue capacity counts unfinished prompts; completed messages
  // remain in a separate bounded recent-history projection.
  if (state.ledger.length >= HISTORY_LIMIT) {
    const settled = state.ledger.findIndex((entry) => entry.response !== null);
    if (settled < 0) throw new ContractError('opencode_prompt_queue_overflow', 'prompt queue is full');
    // Invariant: the join map never outgrows the ledger it mirrors.
    state.requestIdByMessage.delete(state.ledger[settled].userMessageId);
    state.ledger.splice(settled, 1);
  }
  const entry = createEntry(state, text);
  if (input.messageID) entry.userMessageId = input.messageID;
  state.ledger.push(entry);
  // The join revert needs; bounded by dropping the entry it is evicted with.
  state.requestIdByMessage.set(entry.userMessageId, entry.requestId);
  // Why: gold OC opens a fresh session's first prompt with a session.updated
  // pair, but later prompts emit the user message first (ledger lifecycle,
  // not run timing, pins the first-seen event order per stream).
  if (state.ledger.length === 1) emitFirstAdmission(state, entry);
  else emitFollowAdmission(state, entry);
  const bound = state.tail.then(() => runEntry(state, entry));
  state.tail = bound.catch(() => {});
  return { response: bound, messageID: entry.userMessageId };
}

function pendingCount(state) {
  return state.ledger.reduce((count, entry) => count + Number(entry.response === null), 0);
}

async function runEntry(state, entry) {
  // Why: an aborted queued entry was settled by the wire abort path; its
  // chained turn must not submit a fresh prompt after the operator's stop.
  if (entry.aborted) return entry.response;
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
  // Why: a cancelled turn settles distinctly from an engine failure; the wire
  // voice labels operator-stopped turns `abort` so OpenChamber can render it.
  entry.finish = result?.outcome === 'completed' ? 'stop'
    : result?.outcome === 'cancelled' ? 'abort' : 'error';
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
  // Compatibility: OpenCode 2 writes an `idle` record when a turn ends, and a
  // client walks history newest-first to find where the running turn began.
  // Without the marker every turn reads as one continuous turn.
  entry.idle = idleInfo(state, entry);
}

function idleInfo(state, entry) {
  return {
    id: newId('msg'), sessionID: state.sessionID, type: 'idle',
    outcome: entry.finish === 'abort' ? 'interrupted' : entry.finish === 'error' ? 'failed' : 'succeeded',
    time: { created: entry.closedAt ?? Date.now() },
  };
}

// Why: the operator stop button must stop everything, not just the active
// turn: queued prompts never reach the engine, so the wire abandons them here
// (settled responses, no busy frames, and an idle sentinel when nothing runs).
function abortPending(state) {
  const drained = [];
  for (const entry of state.ledger) {
    if (entry.response !== null || entry === state.active) continue;
    entry.aborted = true;
    entry.finish = 'abort';
    entry.textEnded = Date.now();
    entry.assistantCompleted = entry.textEnded;
    publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: textPartFinal(state, entry), time: entry.textEnded });
    publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepFinishPart(state, entry), time: entry.textEnded });
    entry.response = buildAssistantResponse(state, entry);
    publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: entry.response.info });
    // Why: a drained prompt settled without ever running, so it still needs the
    // idle marker that bounds its turn. Without it a newest-first history walk
    // reads the abandoned turn as the one still running.
    entry.idle = idleInfo(state, entry);
    drained.push(entry);
  }
  if (drained.length > 0 && state.active === null) {
    publishBare(state, 'session.status', { sessionID: state.sessionID, status: { type: 'idle' } });
    publishBare(state, 'session.idle', { sessionID: state.sessionID });
  }
  return drained.length;
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
    assistantContent: '', finish: null, tokens: ZERO_TOKENS, response: null, aborted: false,
    toolParts: new Map(), assistantParts: [], retryAnnounced: false,
  };
}

function buildAssistantResponse(state, entry) {
  return {
    info: assistantInfo(state, entry, { completed: entry.assistantCompleted, finish: entry.finish ?? 'error' }),
    // Why: tool parts sit between the step's opening and its finish, so a client
    // renders each call where the model made it rather than after the answer.
    parts: [stepStartPart(state, entry), ...(entry.assistantParts ?? []), textPartFinal(state, entry), stepFinishPart(state, entry)],
  };
}

function messagesFromLedger(state) {
  const messages = [];
  for (const entry of state.ledger) {
    messages.push({ info: closedUserInfo(state, entry), parts: [userPart(state, entry)] });
    if (entry.response !== null) messages.push({ info: entry.response.info, parts: entry.response.parts });
    // Why: oldest-first history pairs each closed turn with the idle marker that
    // ends it, so a newest-first reader stops at the correct turn boundary.
    if (entry.idle) messages.push({ info: entry.idle, parts: [] });
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
  const maxText = limits.maxText ?? DEFAULT_PART_TEXT_ALLOWANCE;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new ContractError('opencode_prompt_parts_invalid', 'prompt requires at least one text part');
  }
  if (parts.length > maxParts) throw new ContractError('opencode_prompt_parts_invalid', 'prompt exceeds part bounds');
  const texts = [];
  let totalBytes = 0;
  for (const part of parts) {
    const text = requireTextPart(part, maxText);
    totalBytes += Buffer.byteLength(text, 'utf8') + Number(texts.length > 0);
    if (totalBytes > maxText) throw new ContractError('opencode_prompt_parts_invalid', 'combined prompt text exceeds bounds');
    texts.push(text);
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
