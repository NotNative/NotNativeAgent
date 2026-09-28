// SPDX-License-Identifier: Apache-2.0
import { isTerminalToolStatus } from './experience/tool-lifecycle.js';

const PHASES = new Set([
  'idle', 'preparing', 'waiting_provider', 'reasoning', 'streaming', 'awaiting_approval',
  'running_tool', 'recovering', 'attention_required', 'cancelling', 'failed', 'needs_input',
]);

/** NNA output is the only source of turn state; work output only triggers a fresh engine snapshot. */
export function observeNndSessionState(context, record, activeTools = null) {
  if (record.type === 'work_status') {
    context.updatedAt = Math.max(Date.now(), context.updatedAt + 1);
    return true;
  }
  if (shouldClearNndToolPhase(record, context.turnState, activeTools)) {
    context.turnState = null;
    context.updatedAt = Math.max(Date.now(), context.updatedAt + 1);
    return true;
  }
  const phase = nndPhaseFromOutput(record);
  if (!phase || context.turnState === phase) return false;
  context.turnState = phase;
  context.updatedAt = Math.max(Date.now(), context.updatedAt + 1);
  return true;
}

/** Structured stream/tool events fill the intervals between explicit states. */
export function nndPhaseFromOutput(record) {
  return record?.type === 'state_status' && PHASES.has(record.semantic_state)
    ? record.semantic_state
    : record.type === 'stream_delta' && record.delta_type === 'text' && typeof record.text === 'string' && record.text.length
      ? 'streaming'
      : record.type === 'tool_status' && record.status === 'running' && typeof record.tool === 'string'
        ? 'running_tool'
        : record.type === 'tool_status' && record.status === 'review_pending' && typeof record.tool === 'string'
          ? 'awaiting_approval' : null;
}

export function nndTurnStateProjection(context) {
  return PHASES.has(context.turnState) ? { phase: context.turnState } : null;
}

/** A terminal tool event can arrive without a following state_status. Do not
 * keep claiming that a tool is running once no correlated running tool remains.
 * Unknown snapshots also cannot support that claim. */
export function shouldClearNndToolPhase(record, phase, activeTools) {
  return phase === 'running_tool' && record?.type === 'tool_status'
    && isTerminalToolStatus(record.status) && !activeTools?.count;
}
