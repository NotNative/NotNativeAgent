// SPDX-License-Identifier: Apache-2.0
// Per-session OpenCode wire voice: turn cadence on /global/event, the wire
// id/part ledger that message synthesis reads back, and the prompt queue
// chain. Gold-observed OC semantics live here: prompts while busy queue
// (never reject), durable events pair with a `sync` mirror carrying the same
// event id and a per-session monotonic seq, while status/idle/diff/delta
// frames ride bare; the sync prompt response resolves after the turn closes.
import { ContractError, newId } from '../ids.js';
import { persistEngineRecord } from '../engine/persistence.js';
import { createHash } from 'node:crypto';
import { physicalWireAllowance } from '../reliability/context-budget.js';
import { PROTOCOL_TOOL_NAMES } from '../tools/core-names.js';
import { toolSummary, toolDisplayOutput, toolPartState } from './tool-summary.js';
import { buildPromptCommand as composePromptText } from './prompt-parts.js';
import {
  ZERO_TOKENS, assistantInfo, buildAssistantResponse, closeTurn, abortPending, currentInfo, idleInfo, publishBare, publishDurable,
  settleAbandoned, settleEntry, settleFailure, stepStartPart, textSegmentOpen, openTextSegment, closedUserInfo, userPart, userInfo, tokenView, seededEntry,
} from './wire-transcript.js';

const QUEUE_LIMIT = 64;
// Why 16: a held synthetic is client-authored briefing text waiting for the
// next scheduled turn, not an operator prompt. The clients that use it
// (goal mode, context-obligation ticks) hold one or two at a time, so a
// larger pile is a stuck caller rather than a real conversation.
const HELD_LIMIT = 16;
const HISTORY_LIMIT = 64;
const MAX_PROMPT_PARTS = 128;
const DEFAULT_PART_TEXT_ALLOWANCE = physicalWireAllowance(65_536);

export function createWireSession({ record, bus, info, version, publishV2 = null }) {
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
    // Why: timeline mutations happen outside a turn, so they cannot ride the
    // per-turn cadence. They still have to reach the v2 event stream the client
    // renders revert state from, which is a separate stream from the v1 bus.
    publishV2(type, properties) { publishV2?.(state, type, properties); },
    prompt(parts) { return admit(state, parts).response; },
    admit(parts, input = {}) { return admit(state, parts, input); },
    abort() { return abortPending(state); },
    // Why a per-entry withdraw: a revert targeting a pending turn removes it from the
    // queue before the marker lands, so the journal never records a taken-back turn.
    withdrawPending(requestId) { return withdrawPending(state, requestId); },
    messages() { return messagesFromLedger(state); }, pendingCount() { return pendingCount(state); },
    // Compatibility: a restored session's replayed turns enter the same ledger
    // live turns use, so history, revert joins, and eviction stay uniform.
    seedHistory(turns) { return seedHistory(state, turns); },
  };
}

function applyModelRef(state, next) {
  if (typeof next?.providerID === 'string' && next.providerID) state.modelRef.providerID = next.providerID;
  // Why `id` as well as `modelID`: a `Provider.Model.Ref` names its model `id`,
  // and that is the shape the durable index stores and a restore replays. The
  // `modelID` spelling stays for the internal selection objects that carry it.
  const modelID = typeof next?.modelID === 'string' && next.modelID ? next.modelID
    : typeof next?.id === 'string' && next.id ? next.id : null;
  if (modelID) state.modelRef.modelID = modelID;
  // Compatibility: `variant` is the thinking level the operator chose. A client
  // shows it beside the model, so a restored session has to report the level it
  // ran at rather than silently dropping to the model's default.
  if (typeof next?.variant === 'string' && next.variant) state.modelRef.variant = next.variant;
  else delete state.modelRef.variant;
}

// Why published: the client's context pane renders a live "X% used" meter from
// this; without it an operator compacting by hand has no per-turn visibility.
function publishContextUsage(state, record) {
  const perTurn = record.type === 'context_status';
  publishBare(state, 'nna.context.usage', {
    sessionID: state.sessionID, turnID: record.turn_id ?? null,
    estimatedTokens: (perTurn ? record.estimated_tokens : record.current_estimated_tokens) ?? null,
    limitTokens: record.limit_tokens ?? null, contextWindowTokens: record.limit_tokens ?? null,
    rawEstimatedTokens: (perTurn ? record.raw_estimated_tokens : record.current_estimated_tokens) ?? null,
    pressureTier: perTurn ? (record.pressure_tier ?? 'none') : null,
    compactionThresholdTokens: perTurn ? (record.compaction_threshold_tokens ?? null) : null,
    measurement: record.measurement ?? 'estimated',
  });
}

function observeEngineRecord(state, record) {
  if (record?.type === 'context_compaction_status' && state.active) {
    // Compatibility: OpenCode has no standard compaction part, and a v2 client
    // announces a finished compaction from `session.compaction.ended` — it has
    // no case for the extension below, so only a settled compaction is also
    // announced there; a skipped or in-flight one did not compact.
    publishBare(state, 'nna.context.compaction', {
      sessionID: state.sessionID, turnID: record.turn_id ?? null,
      status: record.status, trigger: record.trigger ?? null, reasonCode: record.reason_code ?? null,
      beforeEstimatedTokens: record.before_estimated_tokens ?? null,
      afterEstimatedTokens: record.after_estimated_tokens ?? null,
      targetTokens: record.target_tokens ?? null,
      contextWindowTokens: record.context_window_tokens ?? null,
      inputGrowthTokens: record.input_growth_tokens ?? null,
    });
    if (record.status === 'completed' || record.status === 'failed') {
      publishBare(state, 'session.compaction.ended', { sessionID: state.sessionID });
    }
    return;
  }
  if (record?.type === 'context_status' || record?.type === 'context_usage') {
    publishContextUsage(state, record);
    return;
  }
  if (record?.type === 'stream_delta' && state.active) {
    // Why a segment here: prose that follows tool calls is a new block. One text
    // part for the whole turn renders every prose block first and all the tool
    // calls after it, because the client orders parts by arrival.
    if (state.active.textClosed === true) openTextSegment(state, state.active);
    publishBare(state, 'message.part.delta', {
      sessionID: state.sessionID, messageID: state.active.assistantId, partID: state.active.textPartId,
      field: 'text', delta: record.text ?? '',
    });
    const segment = state.active.textSegments?.at(-1);
    if (segment) segment.text += record.text ?? '';
    if (state.active.deltaStart === null) state.active.deltaStart = Date.now();
    return;
  }
  if (record?.type === 'tool_status' && state.active) observeToolStatus(state, record);
  // Why: NNA waits out a provider outage before retrying. Without a wire signal the
  // client shows a bare busy status, so an operator cannot tell a stalled turn
  // from a recovering one.
  if (record?.type === 'state_status' && state.active && record.semantic_state === 'recovering'
    && state.active.retryAnnounced !== true) {
    state.active.retryAnnounced = true;
    publishBare(state, 'session.retry.scheduled', {
      sessionID: state.sessionID, attempt: null,
      error: { message: 'The provider is unavailable. NNA is waiting before it retries.' },
    });
  }
}

// Why: a v2 transcript shows tool calls as parts of the assistant message. The
// Why: a v2 transcript shows tool calls as parts of the assistant message; the
// engine reports each tool's name and lifecycle, and the wire projects it into
// the tool state a client renders. Compatibility: the live OpenChamber transcript
// is driven by the `session.tool.*` lifecycle — it dispatches no case for
// `message.part.updated` — so without the lifecycle events a tool-using turn runs
// with no tool row until it is reloaded. See publishToolLifecycle for the order.
// Security: tool rows carry the tool name and its state only; arguments and raw
// results stay with the engine, since a tool's input can contain a secret and its
// output can contain retrieved content that must not gain authority.
const RUNNING_TOOL_STATES = new Set(['review_pending', 'approved', 'running']);

function observeToolStatus(state, record) {
  if (typeof record.tool !== 'string' || !record.tool) return;
  // Why: a protocol tool declares turn control instead of doing visible work, and
  // OpenCode has no call to show for it; rendering it would invent a tool step.
  if (PROTOCOL_TOOL_NAMES.includes(record.tool)) return;
  const key = record.tool_request_id ?? record.provider_call_id ?? record.tool;
  const nowMs = Date.now();
  let part = state.active.toolParts.get(key);
  if (!part) {
    part = { id: newId('prt'), messageID: state.active.assistantId, sessionID: state.sessionID,
      type: 'tool', name: record.tool, time: { created: nowMs }, state: null };
    state.active.toolParts.set(key, part);
    // Why the close here: a tool call ends the prose block the model wrote before
    // it. The next stream delta opens a fresh text segment, so the transcript keeps
    // prose and calls in the order the model produced them.
    state.active.textClosed = true;
  }
  const previous = part.state;
  const status = record.status;
  const terminal = status === 'succeeded' ? 'completed' : RUNNING_TOOL_STATES.has(status) ? null : 'error';
  part.state = toolPartState(record, terminal);
  if (part.state.status === 'running') part.time.ran = nowMs; else part.time.completed = nowMs;
  // Why publish the part: a surface projecting the transcript from events learns
  // about a tool call only from a part update; returning the part in the final
  // response is not enough — the v2 workspace listens to the bus.
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part, time: nowMs });
  publishToolLifecycle(state, part, previous, terminal);
  // Compatibility: the part is projected on the assistant message so a client
  // rebuilding the transcript from parts renders the call in place.
  const assistant = state.active.assistantParts ?? [];
  const existing = assistant.findIndex((item) => item.id === part.id);
  if (existing >= 0) assistant[existing] = part; else assistant.push(part);
}

/** Announce one tool transition in the vocabulary the live transcript reads.
 *  Why the prelude: the client opens a tool row only on `input.started`, moves it
 *  out of `streaming` only on `called`, and drops `success` unless the row is
 *  already `running` and `failed` unless it is `streaming` or `running`. The
 *  engine's lifecycle can be a single terminal record, so a terminal event for a
 *  row the client never saw opened is preceded by the events that open it.
 *  Why a summary rather than empty input: a client labels a row from the call's
 *  input, so an empty object is what rendered a turn as a column of bare tool
 *  names. The summary carries the journal's redacted target, never raw arguments.
 *  `executed` is what NNA actually observed — a tool that reached running ran, and
 *  one stopped by review before it never did. */
function publishToolLifecycle(state, part, previous, terminal) {
  const base = { sessionID: state.sessionID, assistantMessageID: state.active.assistantId, id: part.id };
  const input = part.state?.input ?? {};
  if (!previous) publishDurable(state, 'session.tool.input.started', { ...base, name: part.name });
  if (previous?.status !== 'running') {
    publishDurable(state, 'session.tool.called', { ...base, input, executed: Boolean(part.time.ran) || terminal === 'completed' });
  }
  const contentText = typeof part.state?.metadata?.outcome === 'string' ? part.state.metadata.outcome : '';
  if (terminal === 'completed') {
    publishDurable(state, 'session.tool.success', { ...base, content: [{ type: 'text', text: contentText }], executed: true });
  }
  if (terminal === 'error') {
    publishDurable(state, 'session.tool.failed', { ...base, error: part.state.error, executed: Boolean(part.time.ran) });
  }
}

function admit(state, parts, input = {}) {
  const text = buildPromptCommand(parts, { maxText: physicalWireAllowance(
    state.record.engine?.ingressContextWindowTokens ?? state.record.engine?.lastContextMeasurement?.windowTokens ?? 65_536,
  ) });
  if (pendingCount(state) >= QUEUE_LIMIT) {
    throw new ContractError('opencode_prompt_queue_overflow', 'prompt queue is full', false, { httpStatus: 429 });
  }
  // Invariant: queue capacity counts unfinished prompts; completed messages
  // remain in a separate bounded recent-history projection.
  if (state.ledger.length >= HISTORY_LIMIT) {
    const settled = state.ledger.findIndex((entry) => entry.response !== null);
    if (settled < 0) throw new ContractError('opencode_prompt_queue_overflow', 'prompt queue is full', false, { httpStatus: 429 });
    // Invariant: the join map never outgrows the ledger it mirrors.
    state.requestIdByMessage.delete(state.ledger[settled].userMessageId);
    state.ledger.splice(settled, 1);
  }
  const entry = createEntry(state, text);
  if (input.messageID) entry.userMessageId = input.messageID;
  state.ledger.push(entry);
  // The join revert needs; bounded by dropping the entry it is evicted with.
  state.requestIdByMessage.set(entry.userMessageId, entry.requestId);
  if (input.held) return holdEntry(state, entry, input);
  // Why: gold OC opens a fresh session's first prompt with a session.updated
  // pair, but later prompts emit the user message first (ledger lifecycle,
  // not run timing, pins the first-seen event order per stream).
  // Why count scheduled admissions rather than ledger length: a held briefing
  // admitted before the first prompt (goal mode admits it first on purpose)
  // must not consume the opening pair the first real turn depends on.
  if (state.scheduled === undefined) {
    state.scheduled = 0;
    emitFirstAdmission(state, entry);
  } else emitFollowAdmission(state, entry);
  state.scheduled += 1;
  const bound = state.tail.then(() => runEntry(state, entry));
  state.tail = bound.catch(() => {});
  return { response: bound, messageID: entry.userMessageId };
}

/** Admit a synthetic input without scheduling a turn.
 *
 *  Why no assistant row or idle marker: a held entry is not a turn. Gold OC publishes
 *  the `session.synthetic` row itself for this case and opens no assistant turn, so no
 *  run state, status frame, or turn boundary appears — a client would otherwise show a
 *  session running with nothing in it.
 *  Compatibility: no `session.inbox.enqueued` either. The OpenChamber reducer inserts
 *  an enqueued item into its pending queue and removes it on delivery or cancellation,
 *  so an item that is never steered and never cancelled sits in the composer queue
 *  indefinitely. `session.synthetic` is the event the client renders this row from,
 *  both live and (via history) after a reload. */
function holdEntry(state, entry, input) {
  if (heldPending(state) >= HELD_LIMIT) {
    state.ledger.splice(state.ledger.indexOf(entry), 1);
    state.requestIdByMessage.delete(entry.userMessageId);
    throw new ContractError('opencode_prompt_queue_overflow', 'held synthetic queue is full', false, { httpStatus: 429 });
  }
  entry.held = true;
  entry.createdAt = Date.now();
  entry.textEnded = entry.createdAt;
  entry.assistantCompleted = entry.createdAt;
  if (input.metadata) entry.metadata = input.metadata;
  publishDurable(state, 'session.synthetic', {
    sessionID: state.sessionID, text: entry.text,
    ...(input.description ? { description: input.description } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  // Why a `response` with no assistant: the row is complete on its own and
  // history must stop at it, so the entry reads as settled to the queue, the
  // idle sentinel, and eviction, while `messagesFromLedger` still skips the
  // empty assistant it never opened.
  entry.response = { info: null, parts: [] };
  return { response: Promise.resolve(entry.response), messageID: entry.userMessageId, held: true };
}

function heldPending(state) {
  return state.ledger.reduce((count, entry) => count + Number(Boolean(entry.held) && entry.deliveredAt === undefined), 0);
}

function pendingCount(state) {
  // Why held entries do not count: they are settled rows that never run, so
  // they must not consume prompt-queue capacity — the client holds a briefing
  // and then prompts, and that prompt has to be admitted.
  return state.ledger.reduce((count, entry) => count + Number(entry.response === null && !entry.held), 0);
}

/** Withdraw one pending entry by engine request id: the scheduler can hold an
 *  admitted prompt for capacity, and a revert targeting that turn must take it
 *  back before it reaches the provider — a queue withdrawal never contacts the
 *  provider, unlike a stream cancel. Returns whether the entry was withdrawn. */
function withdrawPending(state, requestId) {
  if (!requestId) return false;
  const entry = state.ledger.find((item) => item.requestId === requestId
    && item.response === null && !item.held && item !== state.active);
  if (!entry) return false;
  settleAbandoned(state, entry);
  return true;
}
async function runEntry(state, entry) {
  // Why: an aborted queued entry was settled by the wire abort path; its
  // chained turn must not submit a fresh prompt after the operator's stop.
  // The briefings it would have carried stay undelivered, so the next real
  // turn still reads them.
  if (entry.aborted) return entry.response;
  state.active = entry;
  entry.assistantCreated = entry.createdAt;
  entry.textStart = Date.now();
  emitTurnStarted(state, entry);
  try {
    await journalBriefings(state);
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

/** Carry the briefings held since the last turn into the engine journal.
 *
 *  Why the journal and not the submission: the client contract says a synthetic
 *  input is admitted "and schedules agent-loop execution unless resume is
 *  false", and the goal-mode caller says plainly that without `resume: false`
 *  "the model would start on the briefing alone, before the task arrived". So
 *  a held briefing must never open its own turn, yet it must reach the model
 *  with the next real prompt. The two submission lanes cannot carry it:
 *  `submit.content` is journaled as an operator utterance and `engine.steer`
 *  is converted to one, and this text is client-authored context, not operator
 *  speech. A `message` record appended before the submission reaches the
 *  provider as transcript context under its own trust, which is exactly the
 *  lane the engine uses for recalled memory and hook context.
 *
 *  Security: never let this text reach `submit.content`, `engine.steer`, or any
 *  other lane that journals `trust: 'operator'`. AGENTS.md forbids content
 *  that arrived over the wire from granting authority, and the role is
 *  `system` rather than `user` so no projection that reads operator
 *  authority — the conversation text lane, the project-memory reconciler, or
 *  skill opportunity mining — can ever treat it as an authenticated utterance.
 *
 *  Invariant: journaling happens at the turn boundary, before the submission,
 *  and never mutates an entry's `text`, so the wire rows, the part ledger, and
 *  revert still read exactly what each caller admitted. A record carries no
 *  `turnId`: the briefing is client-authored context, not part of the turn that
 *  consumed it, so reverting that turn must not erase it. */
async function journalBriefings(state) {
  const held = state.ledger.filter((item) => item.held && !item.deliveredAt);
  if (held.length === 0) return;
  const engine = state.record?.engine;
  const now = Date.now();
  for (const item of held) {
    await persistEngineRecord(engine, 'message', {
      type: 'message', role: 'system', content: item.text,
      trust: 'untrusted_client_briefing', partial: false, createdAt: now,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    });
    item.deliveredAt = now;
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
  openTextSegment(state, entry, nowMs);
}


function createEntry(state, text) {
  return {
    requestId: newId('oc_prompt'), text,
    userMessageId: newId('msg'), userPartId: newId('prt'),
    assistantId: newId('msg'), stepStartId: newId('prt'), textPartId: newId('prt'), stepFinishId: newId('prt'),
    createdAt: Date.now(), assistantCreated: null, assistantCompleted: null,
    textStart: null, textEnded: null, deltaStart: null, closedAt: null,
    assistantContent: '', finish: null, tokens: ZERO_TOKENS, response: null, aborted: false,
    toolParts: new Map(), assistantParts: [], retryAnnounced: false,
    textSegments: [], textClosed: false,
  };
}

function messagesFromLedger(state) {
  const messages = [];
  for (const entry of state.ledger) {
    messages.push({ info: closedUserInfo(state, entry), parts: [userPart(state, entry)] });
    // Why check `info`: a held briefing settles with no assistant message at
    // all, and pushing that empty response would hand a reader a row with a
    // null `info` to dereference.
    if (entry.response !== null && entry.response.info !== null) messages.push({ info: entry.response.info, parts: entry.response.parts });
    // Why: oldest-first history pairs each closed turn with the idle marker that
    // ends it, so a newest-first reader stops at the correct turn boundary.
    if (entry.idle) messages.push({ info: entry.idle, parts: [] });
  }
  return messages;
}

/** Enter replayed turns into the wire ledger as settled entries.
 *  Why a settled entry rather than a fresh admission: a restored turn already ran
 *  in a previous process. It must render in history and answer a revert join by
 *  its engine request id, but it must not count as pending or re-emit its events,
 *  so each entry lands fully settled with its replayed idle marker. The queue
 *  capacity counts `response === null` entries only, so settled history never
 *  consumes live-prompt capacity, and eviction of the oldest settled entry works.
 *  Security: the seeded text is the operator prompt and the settled answer the
 *  engine's own journal carries. Tool rows enter through the same projection live
 *  turns use, which records names and states only. */
function seedHistory(state, turns) {
  if (!Array.isArray(turns)) return 0;
  let seeded = 0;
  for (const turn of turns.slice(-HISTORY_LIMIT)) {
    if (!turn || typeof turn.text !== 'string') continue;
    const entry = seededEntry(state, turn);
    if (entry.requestId) state.requestIdByMessage.set(entry.userMessageId, entry.requestId);
    state.ledger.push(entry);
    seeded += 1;
  }
  return seeded;
}

/** Compatibility: this module's bounds are the surface's policy, so the call
 *  site supplies them; the rules themselves live in `prompt-parts.js`. */
export function buildPromptCommand(parts, limits = {}) {
  return composePromptText(parts, {
    maxParts: limits.maxParts ?? MAX_PROMPT_PARTS,
    maxText: limits.maxText ?? DEFAULT_PART_TEXT_ALLOWANCE,
  });
}

export function snapshotValue(directory) {
  return createHash('sha256').update(String(directory)).digest('hex').slice(0, 40);
}
