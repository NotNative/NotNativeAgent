// SPDX-License-Identifier: Apache-2.0
// Why: a durable tool_request must never lack a paired tool_result. These
// helpers synthesize the honest terminal shapes for approvals the harness
// could not run or settle mid-turn; they mirror (and run earlier than) the
// restart-time repair in src/reliability/interrupted-tools.js.
export function pairUnsettledApprovals(items) {
  // An item that reached execution gets the same honest unknown-effect
  // outcome the restart repair would synthesize; an approved item never
  // dispatched is honestly not executed.
  for (const item of items) {
    if (item.finished || item.result || item.decision?.outcome !== 'approve') continue;
    item.result = unsettledApprovalResult(item);
  }
}

export function unsettledApprovalResult(item) {
  const dispatched = item.child.state === 'running';
  return Object.freeze({
    request_id: item.request?.id ?? null,
    provider_call_id: item.request?.providerCallId ?? item.call.providerCallId ?? null,
    tool_name: item.request?.toolName ?? item.call.name ?? null,
    status: dispatched ? 'unknown_effect' : 'cancelled',
    content: dispatched
      ? 'The harness lost this tool after dispatch without recording a terminal result. The external outcome is unknown. Verify external state before retrying; do not assume the operation did nothing.'
      : 'The harness abandoned this approved tool before dispatch because the step failed. It produced no external effect and may be retried if it is still needed.',
    truncated: false, elapsed_ms: 0,
    effect_certainty: dispatched ? 'unknown' : 'none',
    untrusted: true,
    reason_code: dispatched ? 'tool_execution_unsettled' : 'tool_execution_not_dispatched',
    metadata: Object.freeze({ synthetic: true, recovery: 'unsettled_approval' }),
    ledger_started: dispatched,
  });
}

export function cancelledToolResult(item) {
  return Object.freeze({
    request_id: item.request?.id ?? null,
    provider_call_id: item.request?.providerCallId ?? item.call.providerCallId ?? null,
    tool_name: item.request?.toolName ?? item.call.name ?? null,
    status: 'cancelled', content: 'tool execution was cancelled',
    truncated: false, elapsed_ms: 0, effect_certainty: 'none',
    untrusted: true, reason_code: 'tool_cancelled', ledger_started: false,
  });
}
