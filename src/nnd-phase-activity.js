// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { nndPhaseFromOutput } from './nnd-turn-state.js';

const LABELS = Object.freeze({
  idle: 'Turn idle', preparing: 'Preparing turn', waiting_provider: 'Waiting for model',
  reasoning: 'Model reasoning', streaming: 'Streaming response',
  awaiting_approval: 'Awaiting approval', running_tool: 'Running tool',
  recovering: 'Recovering turn', attention_required: 'Operator attention required',
  cancelling: 'Cancelling turn', failed: 'Turn failed', needs_input: 'Turn needs input',
});

/** Classify only the engine's bounded semantic vocabulary, never raw model
 * text, reasoning, provider payloads, or tool arguments. State is per turn. */
export function observeNndPhaseActivity(state, record, sessionID, evidenceMessageID = null) {
  const phase = nndPhaseFromOutput(record);
  if (!phase) return null;
  if (state.lastPhase === phase) return null;
  state.lastPhase = phase;
  state.phaseActivitySequence = (state.phaseActivitySequence ?? 0) + 1;
  const status = phase === 'failed' ? 'failed'
    : ['awaiting_approval', 'attention_required', 'needs_input'].includes(phase) ? 'attention'
      : phase === 'idle' ? 'completed' : 'started';
  // A request ID can be retried after a failed attempt with no journal entry.
  // Give each observed turn a fresh scope so replay rows are never overwritten.
  state.phaseActivityScope ??= randomUUID();
  return { id: `${sessionID}:state:${state.phaseActivityScope}:${state.phaseActivitySequence}`, sessionID, kind: 'state',
    status, summary: LABELS[phase], time: Date.now(),
    ...(evidenceMessageID ? { evidenceMessageID } : {}) };
}

export function nndCompactionActivity(turn, record, sessionID) {
  if (!['started', 'completed', 'skipped', 'failed'].includes(record.status)) return null;
  const status = record.status === 'failed' ? 'failed' : record.status === 'started' ? 'started' : 'completed';
  const before = record.before_estimated_tokens;
  const after = record.after_estimated_tokens;
  const measured = record.status === 'completed' && Number.isSafeInteger(before) && before >= 0
    && Number.isSafeInteger(after) && after >= 0;
  const summary = measured
    ? `Context compaction completed: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} estimated input tokens`
    : `Context compaction ${record.status}`;
  // Invariant: two compactions in one turn must remain separate activity rows.
  turn.compactionActivityScope ??= randomUUID();
  turn.compactionActivitySequence = (turn.compactionActivitySequence ?? 0) + 1;
  return { id: `${sessionID}:compaction:${turn.compactionActivityScope}:${turn.compactionActivitySequence}`,
    sessionID, kind: 'notice', status, summary, time: Date.now() };
}
