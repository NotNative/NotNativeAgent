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
  let seeded = 0;
  for (const turn of turns) {
    if (!turn || typeof turn.text !== 'string') continue;
    const created = Number.isFinite(turn.createdAt) ? turn.createdAt : state.info.time.created ?? Date.now();
    const completed = Number.isFinite(turn.completedAt) ? turn.completedAt : created;
    const user = { id: `msg_${turn.userKey}`, sessionID: state.info.id, type: 'user', time: { created }, text: turn.userText ?? '' };
    // Why an interleaved order: the journal records the order the model actually
    // produced - prose between calls, not all calls then all prose. Tools carry an
    // arrival ordinal from the journal walk, and the answer carries where it landed
    // among them, so a restored transcript shows the shape the live one did.
    const answer = { type: 'text', text: turn.text, order: turn.textOrder ?? Number.MAX_SAFE_INTEGER };
    const parts = [...[...turn.tools?.values() ?? []].map((tool) => ({ ...tool, order: tool.order ?? Number.MAX_SAFE_INTEGER })), answer]
      .sort((left, right) => left.order - right.order)
      .map(({ order, ...part }) => part);
    const assistant = {
      id: `msg_${turn.assistantKey}`, sessionID: state.info.id, type: 'assistant', agent: 'build', model: state.info.model,
      time: { created, completed }, content: parts,
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
