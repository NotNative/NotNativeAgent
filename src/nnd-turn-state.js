// SPDX-License-Identifier: Apache-2.0
const PHASES = new Set([
  'idle', 'preparing', 'waiting_provider', 'reasoning', 'streaming', 'awaiting_approval',
  'running_tool', 'recovering', 'attention_required', 'cancelling', 'failed', 'needs_input',
]);

/** NNA output is the only source of turn state; work output only triggers a fresh engine snapshot. */
export function observeNndSessionState(context, record) {
  if (record.type === 'work_status') {
    context.updatedAt = Math.max(Date.now(), context.updatedAt + 1);
    return true;
  }
  // Compatibility: the engine emits structured stream/tool events between
  // explicit state_status records. These transitions match its TUI fold.
  const phase = record.type === 'state_status' && PHASES.has(record.semantic_state)
    ? record.semantic_state
    : record.type === 'stream_delta' && record.delta_type === 'text' && typeof record.text === 'string' && record.text.length
      ? 'streaming'
      : record.type === 'tool_status' && record.status === 'running' && typeof record.tool === 'string'
        ? 'running_tool'
        : record.type === 'tool_status' && record.status === 'review_pending' && typeof record.tool === 'string'
          ? 'awaiting_approval' : null;
  if (!phase || context.turnState === phase) return false;
  context.turnState = phase;
  context.updatedAt = Math.max(Date.now(), context.updatedAt + 1);
  return true;
}

export function nndTurnStateProjection(context) {
  return PHASES.has(context.turnState) ? { phase: context.turnState } : null;
}
