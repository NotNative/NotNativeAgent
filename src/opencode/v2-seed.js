// SPDX-License-Identifier: Apache-2.0
// Seeded transcript rows for a restored OpenCode session's v2 projection.
//
// Why not replay events: the seeded turns already ran in a previous process;
// re-emitting `session.created`/`session.status`/tool lifecycles for them would
// make a reconnecting client believe the session is live. Each turn lands as
// its final shape directly — user row, assistant row with parts, and the idle
// marker a newest-first history walk needs — with no running state.
//
// Security: tool rows carry name, state, and a bounded guidance message only;
// arguments and raw results stay with the engine, the same as live turns.
import { tokenUsage } from './v2-contract.js';

export function seedProjectionState(state, turns) {
  if (!Array.isArray(turns)) return 0;
  // Why a sequence-derived clock: journal records carry no wall-clock time, so
  // every restored turn would otherwise share the session's creation timestamp
  // and a renderer that orders rows by time could show a reply before the
  // question that caused it. Each row gets a distinct, monotonic stamp derived
  // from the journal sequence: stable across boots, ordered like the
  // conversation ran, and always after the session's own creation time.
  const base = state.info.time.created ?? Date.now();
  let seeded = 0;
  for (const turn of turns) {
    if (!turn || typeof turn.text !== 'string') continue;
    const first = Number.isFinite(turn.firstSequence) ? turn.firstSequence : seeded;
    const last = Number.isFinite(turn.completedSequence) && turn.completedSequence >= first
      ? turn.completedSequence : first + 1;
    const userCreated = base + first * 2;
    const assistantCreated = base + last * 2 + 1;
    const completed = base + last * 2 + 2;
    const user = { id: `msg_${turn.userKey}`, sessionID: state.info.id, type: 'user', time: { created: userCreated }, text: turn.userText ?? '' };
    // Why an interleaved order, and why prose arrives as several parts: the journal
    // records one assistant text per model step, and a multi-step turn writes prose
    // between its tool calls. Each tool and each prose segment carries an arrival
    // ordinal from the journal walk, so a restored transcript shows the shape the
    // live one did - prose blocks beside the calls they introduced.
    const prose = (turn.textSegments ?? [])
      .map((segment) => ({ type: 'text', text: segment.text, order: segment.order }));
    const legacyAnswer = prose.length === 0 && typeof turn.text === 'string'
      ? [{ type: 'text', text: turn.text, order: turn.textOrder ?? Number.MAX_SAFE_INTEGER }] : [];
    const parts = [
      ...[...turn.tools?.values() ?? []].map((tool) => ({ ...tool, order: tool.order ?? Number.MAX_SAFE_INTEGER })),
      ...prose, ...legacyAnswer,
    ].sort((left, right) => left.order - right.order)
      .map(({ order, ...part }) => part);
    const assistant = {
      id: `msg_${turn.assistantKey}`, sessionID: state.info.id, type: 'assistant', agent: 'build', model: state.info.model,
      time: { created: assistantCreated, completed }, content: parts,
      finish: turn.finish ?? 'stop', tokens: turn.tokens ?? tokenUsage(), cost: 0,
    };
    const idle = { id: `msg_${turn.idleKey}`, sessionID: state.info.id, type: 'idle',
      outcome: turn.finish === 'abort' ? 'interrupted' : turn.finish === 'error' ? 'failed' : 'succeeded',
      time: { created: completed } };
    state.messages.set(user.id, user);
    state.messages.set(assistant.id, assistant);
    state.messages.set(idle.id, idle);
    for (const token of ['input', 'output']) state.info.tokens[token] += assistant.tokens[token] ?? 0;
    for (const token of ['read', 'write']) state.info.tokens.cache[token] += assistant.tokens.cache?.[token] ?? 0;
    state.info.cost += assistant.cost;
    state.lastOutcome = assistant.finish === 'abort' ? 'interrupted' : assistant.finish === 'error' ? 'failed' : 'succeeded';
    state.info.outcome = state.lastOutcome;
    state.info.time.idle = completed;
    seeded += 1;
  }
  // Why no events: the client has not subscribed yet (this runs during boot,
  // before the server binds), and a replayed `session.created` would make a
  // later subscriber treat restored sessions as freshly created. The list and
  // the history reads carry everything a client needs after connecting.
  return seeded;
}
