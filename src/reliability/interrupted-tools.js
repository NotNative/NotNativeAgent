// SPDX-License-Identifier: Apache-2.0

const OUTCOME_UNKNOWN = 'process_interrupted_outcome_unknown';
const NOT_STARTED = 'process_interrupted_before_dispatch';

export function interruptedToolRepairs(records, newlyInterruptedTurnIds = []) {
  const interruptedTurns = new Set(newlyInterruptedTurnIds);
  const requests = new Map();
  const settled = new Set();
  const started = new Set();

  for (const record of records) {
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') continue;
    if (record.type === 'turn_interrupted') interruptedTurns.add(turnIdOf(payload));
    else if (record.type === 'tool_request' && payload.type === 'tool_request') {
      const identity = toolIdentity(payload);
      if (identity) requests.set(identity, payload);
    } else if (record.type === 'tool_result' && payload.type === 'tool_result') {
      const identity = toolIdentity(payload);
      if (identity) settled.add(identity);
    } else if (record.type === 'lifecycle_event'
      && payload.event_name === 'tool_execution.started') {
      const identity = payload.tool_request_id;
      if (typeof identity === 'string' && identity.length > 0) started.add(identity);
    }
  }

  const repairs = [];
  for (const [identity, request] of requests) {
    if (!interruptedTurns.has(turnIdOf(request)) || settled.has(identity)) continue;
    repairs.push(syntheticResult(request, started.has(identity)));
  }
  return Object.freeze(repairs);
}

function syntheticResult(request, executionStarted) {
  const reasonCode = executionStarted ? OUTCOME_UNKNOWN : NOT_STARTED;
  return Object.freeze({
    type: 'tool_result', turnId: turnIdOf(request), stepId: request.stepId ?? null,
    requestId: request.requestId, providerCallId: request.providerCallId,
    toolName: request.toolName,
    status: executionStarted ? 'unknown_effect' : 'cancelled',
    content: executionStarted
      ? 'The process stopped after this tool entered execution, but before a result was durably recorded. The external outcome is unknown. Verify external state before retrying; repeat automatically only when the operation is read-only or demonstrably idempotent.'
      : 'The process stopped before this tool entered execution. It produced no external effect and may be retried if it is still needed.',
    metadata: Object.freeze({ synthetic: true, recovery: reasonCode }),
    reasonCode, untrusted: true,
    effectCertainty: executionStarted ? 'unknown' : 'none',
    elapsedMs: 0, truncated: false,
  });
}

function toolIdentity(payload) {
  if (typeof payload.requestId === 'string' && payload.requestId.length > 0) return payload.requestId;
  if (typeof payload.providerCallId === 'string' && payload.providerCallId.length > 0) return payload.providerCallId;
  return null;
}

function turnIdOf(payload) {
  return payload?.turnId ?? payload?.turn_id ?? null;
}
