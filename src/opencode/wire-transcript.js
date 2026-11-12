// SPDX-License-Identifier: Apache-2.0
// Wire transcript synthesis for one session: the message and part shapes a
// turn is published in, and the settlement frames that close it. Split from
// `wire-session.js`, which owns the queue, so each file reads as one contract
// â€” the events a turn looks like versus the ordering of turns.
import { newId } from '../ids.js';

export const ZERO_TOKENS = Object.freeze({ total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

// Why a shared reader: provider usage shapes vary. OpenAI-compatible servers
// nest cache evidence in `prompt_tokens_details.cached_tokens` and reasoning in
// `completion_tokens_details.reasoning_tokens`; Anthropic-style servers report
// flat `cache_read_input_tokens`/`cache_creation_input_tokens`; some report
// flat `cache_read_tokens`. The client's context meter computes the percentage
// and cache hit rate from these fields, so dropping them renders a wrong pane.
const firstPositiveInteger = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 0;
};

/** The provider usage record reduced to the wire token shape, carrying every
 *  field the client's context meter reads. `total` stays as the provider
 *  reported: it is the final round-trip's window, which the meter prefers over
 *  any sum of the parts. */
export function tokenView(usage = {}) {
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const cacheRead = firstPositiveInteger(usage, ['cache_read_tokens', 'cacheReadTokens', 'prompt_cache_hit_tokens', 'cached_tokens'])
    || firstPositiveInteger(usage?.prompt_tokens_details, ['cached_tokens'])
    || firstPositiveInteger(usage, ['cache_read_input_tokens']);
  const cacheWrite = firstPositiveInteger(usage, ['cache_write_tokens', 'cacheWriteTokens'])
    || firstPositiveInteger(usage, ['cache_creation_input_tokens']);
  const reasoning = firstPositiveInteger(usage, ['reasoning_tokens', 'reasoningTokens'])
    || firstPositiveInteger(usage?.completion_tokens_details, ['reasoning_tokens']);
  return {
    total: Number(usage?.total_tokens ?? input + output),
    input, output, reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

/**
 * The context fill a turn leaves behind: the final model step's window when the
 * engine reported one, else the turn's cumulative usage as before.
 *
 * Why not always the cumulative total: a transcript meter reads the newest reply's
 * token total as the current context fill. The cumulative usage bills every step's
 * re-sent prompt, so a multi-step tool-heavy turn reports several times the real
 * fill, which rendered as a context meter above 100 percent.
 */
export function contextFillView(result) {
  return tokenView(result?.context_usage ?? result?.usage ?? {});
}

export function publishDurable(state, type, properties) {
  state.seq += 1;
  state.bus.publishSession({ directory: state.directory, project: state.project, sessionID: state.sessionID, type, properties, mirror: true, seq: state.seq });
}

export function publishBare(state, type, properties) {
  state.bus.publishSession({ directory: state.directory, project: state.project, sessionID: state.sessionID, type, properties });
}

export function currentInfo(state) { return state.info(); }

export function userInfo(state, entry) {
  return {
    id: entry.userMessageId, role: 'user', sessionID: state.sessionID,
    time: { created: entry.createdAt }, agent: 'build',
    model: { providerID: state.modelRef.providerID, modelID: state.modelRef.modelID },
  };
}

export function closedUserInfo(state, entry) {
  return { ...userInfo(state, entry), summary: { diffs: [] } };
}

export function assistantInfo(state, entry, extra = {}) {
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

export function userPart(state, entry) {
  // Compatibility: the v1 vocabulary has no synthetic message type â€” a
  // client-supplied briefing rides as a text part flagged `synthetic: true`,
  // which is how gold OpenCode marked one. Without the flag a legacy reader
  // would render a held briefing as operator speech.
  return { type: 'text', text: entry.text, messageID: entry.userMessageId, sessionID: state.sessionID, id: entry.userPartId,
    ...(entry.held ? { synthetic: true } : {}) };
}

export function stepStartPart(state, entry) {
  return { id: entry.stepStartId, messageID: entry.assistantId, sessionID: state.sessionID, snapshot: state.snapshot, type: 'step-start' };
}

export function textPartOpen(state, entry) {
  return { id: entry.textPartId, messageID: entry.assistantId, sessionID: state.sessionID, type: 'text', text: '', time: { start: entry.textStart } };
}

/**
 * One prose segment of a turn: a text part the model wrote before the next tool
 * call. A multi-step turn writes prose between its calls, so the turn owns several.
 *
 * Why segments rather than one accumulated part: the client renders parts in
 * arrival order, so a single part that grows with every step's prose renders ALL
 * the prose first and every tool call after it - the pile-up an operator sees. A
 * part per segment keeps each prose block beside the calls it introduced.
 */
export function textSegmentOpen(state, entry, segment) {
  return { id: segment.id, messageID: entry.assistantId, sessionID: state.sessionID, type: 'text', text: segment.text, time: { start: segment.startedAt } };
}

export function textSegmentFinal(state, entry, segment) {
  return { id: segment.id, messageID: entry.assistantId, sessionID: state.sessionID, type: 'text', text: segment.text, time: { start: segment.startedAt, end: segment.endedAt ?? segment.startedAt } };
}

/**
 * Open one prose segment of the turn and publish it.
 *
 * Why the first segment opens at step start: a turn usually opens with prose, and
 * the empty part is what the first stream deltas grow. Later segments open when a
 * delta follows tool activity. Each segment is its own text part, so the client
 * renders prose blocks beside the tool calls they introduced.
 */
export function openTextSegment(state, entry, nowMs = Date.now()) {
  const segment = { id: newId('prt'), text: '', startedAt: nowMs };
  entry.textSegments = entry.textSegments ?? [];
  entry.textSegments.push(segment);
  entry.textPartId = segment.id;
  entry.textClosed = false;
  entry.textStart = entry.textStart ?? nowMs;
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: textSegmentOpen(state, entry, segment), time: nowMs });
}

export function textPartFinal(state, entry) {
  return { id: entry.textPartId, messageID: entry.assistantId, sessionID: state.sessionID, type: 'text', text: entry.assistantContent, time: { start: entry.textStart, end: entry.textEnded ?? entry.textStart } };
}

/**
 * The final text parts a settled turn publishes: one per prose segment when the
 * live turn tracked them, else the single accumulated answer as before.
 */
export function finalTextSegments(state, entry) {
  const segments = (entry.textSegments ?? []).filter((segment) => segment.text.length > 0);
  if (segments.length === 0) return [textPartFinal(state, entry)];
  return segments.map((segment) => textSegmentFinal(state, entry, segment));
}

/**
 * The settled ledger entry a restored turn seeds.
 *
 * Why re-stamp here: the seeded tool parts carry only their lifecycle; the wire
 * identity (assistant message, session) is minted in this entry. The response and
 * idle marker are built now, so the entry lands fully settled - it must not count
 * as pending or re-emit its events.
 */
export function seededEntry(state, turn) {
  const entry = {
    requestId: turn.requestId ?? newId('oc_prompt'),
    userMessageId: newId('msg'), userPartId: newId('prt'),
    assistantId: newId('msg'), stepStartId: newId('prt'), textPartId: newId('prt'), stepFinishId: newId('prt'),
    createdAt: Number.isFinite(turn.createdAt) ? turn.createdAt : Date.now(),
    assistantCreated: Number.isFinite(turn.createdAt) ? turn.createdAt : Date.now(),
    assistantCompleted: Number.isFinite(turn.completedAt) ? turn.completedAt : Date.now(),
    textStart: Number.isFinite(turn.createdAt) ? turn.createdAt : Date.now(),
    textEnded: Number.isFinite(turn.completedAt) ? turn.completedAt : Date.now(),
    deltaStart: null, closedAt: Number.isFinite(turn.completedAt) ? turn.completedAt : Date.now(),
    assistantContent: turn.text, finish: turn.finish ?? 'stop',
    tokens: turn.tokens ?? ZERO_TOKENS, response: null, aborted: false,
    toolParts: new Map(), assistantParts: [], retryAnnounced: false, textSegments: [], textClosed: false,
  };
  for (const part of turn.tools?.values() ?? []) {
    entry.assistantParts.push({ ...part, id: `${entry.assistantId}:${part.id}`, messageID: entry.assistantId, sessionID: state.sessionID });
  }
  entry.response = buildAssistantResponse(state, entry);
  entry.idle = idleInfo(state, entry);
  return entry;
}

export function stepFinishPart(state, entry) {
  return { id: entry.stepFinishId, messageID: entry.assistantId, sessionID: state.sessionID, reason: entry.finish ?? 'stop', snapshot: state.snapshot, type: 'step-finish', cost: 0, tokens: entry.tokens ?? ZERO_TOKENS };
}

export function idleInfo(state, entry) {
  return {
    id: newId('msg'), sessionID: state.sessionID, type: 'idle',
    outcome: entry.finish === 'abort' ? 'interrupted' : entry.finish === 'error' ? 'failed' : 'succeeded',
    time: { created: entry.closedAt ?? Date.now() },
  };
}

export function buildAssistantResponse(state, entry) {
  // Why an interleaved order rather than tools-then-text: the settle message is
  // what a client renders as the turn's final shape, so a parts array that appends
  // the answer after every call reorders the turn - prose the model wrote between
  // two calls lands after all of them.
  //
  // Why one part per prose segment: a multi-step turn writes prose between its
  // tool calls, and the client orders parts by arrival. The segments carry their
  // own start times, so sorting them among the tool parts rebuilds the order the
  // model produced. A turn whose segments were never tracked (older paths) keeps
  // the single-part answer as before.
  const segments = (entry.textSegments ?? []).filter((segment) => segment.text.length > 0)
    .map((segment) => textSegmentFinal(state, entry, segment));
  const prose = segments.length > 0 ? segments : [textPartFinal(state, entry)];
  const ordered = [...(entry.assistantParts ?? []), ...prose].sort((left, right) =>
    (left.time?.start ?? left.time?.created ?? 0) - (right.time?.start ?? right.time?.created ?? 0));
  return {
    info: assistantInfo(state, entry, { completed: entry.assistantCompleted, finish: entry.finish ?? 'error' }),
    parts: [stepStartPart(state, entry), ...ordered, stepFinishPart(state, entry)],
  };
}

export function settleEntry(state, entry, result) {
  const nowMs = Date.now();
  entry.assistantContent = typeof result?.text === 'string' ? result.text : '';
  entry.textEnded = nowMs;
  entry.assistantCompleted = nowMs;
  // Why the step window first: a transcript meter reads the newest reply's total as
  // the current context fill. The turn's cumulative usage bills every step's
  // re-sent prompt, so it overstates the fill; the final round-trip is the fill.
  entry.tokens = contextFillView(result);
  // Why: a cancelled turn settles distinctly from an engine failure; the wire
  // voice labels operator-stopped turns `abort` so OpenChamber can render it.
  entry.finish = result?.outcome === 'completed' ? 'stop'
    : result?.outcome === 'cancelled' ? 'abort' : 'error';
  for (const segment of finalTextSegments(state, entry)) publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: segment, time: nowMs });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepFinishPart(state, entry), time: nowMs });
  const response = buildAssistantResponse(state, entry);
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: response.info });
  return response;
}

export function settleFailure(state, entry) {
  const nowMs = Date.now();
  entry.assistantContent = '';
  entry.textEnded = nowMs;
  entry.assistantCompleted = nowMs;
  entry.tokens = ZERO_TOKENS;
  entry.finish = 'error';
  for (const segment of finalTextSegments(state, entry)) publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: segment, time: nowMs });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepFinishPart(state, entry), time: nowMs });
  const response = buildAssistantResponse(state, entry);
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: response.info });
  return response;
}

export function closeTurn(state, entry) {
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

// Why: the operator stop button must stop everything, not just the active
// turn: queued prompts never reach the engine, so the wire abandons them here
// (settled responses, no busy frames, and an idle sentinel when nothing runs).
export function abortPending(state) {
  const drained = [];
  for (const entry of state.ledger) {
    if (entry.response !== null || entry === state.active) continue;
    settleAbandoned(state, entry);
    drained.push(entry);
  }
  if (drained.length > 0 && state.active === null) {
    publishBare(state, 'session.status', { sessionID: state.sessionID, status: { type: 'idle' } });
    publishBare(state, 'session.idle', { sessionID: state.sessionID });
  }
  return drained.length;
}

/** Settle one never-ran entry: aborted, final parts, an idle marker bounding it
 *  in history. Why shared: the stop drain and a revert's withdrawal both take
 *  back queued work that never reached the provider, and both must settle the
 *  row the same honest way. */
export function settleAbandoned(state, entry) {
  entry.aborted = true;
  entry.finish = 'abort';
  entry.textEnded = Date.now();
  entry.assistantCompleted = entry.textEnded;
  for (const segment of finalTextSegments(state, entry)) publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: segment, time: entry.textEnded });
  publishDurable(state, 'message.part.updated', { sessionID: state.sessionID, part: stepFinishPart(state, entry), time: entry.textEnded });
  entry.response = buildAssistantResponse(state, entry);
  publishDurable(state, 'message.updated', { sessionID: state.sessionID, info: entry.response.info });
  // Why: an entry settled without running still needs the idle marker that
  // bounds its turn in a newest-first history walk.
  entry.idle = idleInfo(state, entry);
}
