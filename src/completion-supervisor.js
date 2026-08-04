// SPDX-License-Identifier: Apache-2.0

const TRUNCATED = new Set(['length', 'max_tokens', 'max_output_tokens']);
const TOOL_SIGNAL = new Set(['tool_calls', 'function_call']);

export function evaluateCompletion(active, text) {
  const finishReason = String(active.finishReason ?? '').toLowerCase();
  if (TRUNCATED.has(finishReason)) {
    return Object.freeze({ disposition: 'continue', category: 'truncated_output', progressEvidence: text });
  }
  if (TOOL_SIGNAL.has(finishReason) && active.toolAssembler.size === 0) {
    return Object.freeze({ disposition: 'continue', category: 'missing_tool_call', progressEvidence: null });
  }
  if (lostActiveTask(active, text)) {
    return Object.freeze({ disposition: 'continue', category: 'task_context_lost', progressEvidence: null });
  }
  if ((active.unresolvedToolFailures?.length ?? 0) > 0) {
    if (requestsInput(text)) return Object.freeze({ disposition: 'needs_input', category: 'blocked_after_tool_failure' });
    if (claimsCompletion(text)) {
      return Object.freeze({ disposition: 'continue', category: 'unresolved_tool_failure', progressEvidence: null });
    }
  }
  if (requestsInput(text)) return Object.freeze({ disposition: 'needs_input', category: 'model_requested_input' });
  return Object.freeze({ disposition: 'completed', category: 'settled_output' });
}

export function partialOutputProgress(text) {
  return Object.freeze({
    kind: 'partial_model_output', checkpoint: 'partial_assistant_message_committed',
    summary: Object.freeze({ output_bytes: Buffer.byteLength(text, 'utf8') }),
  });
}

function claimsCompletion(text) {
  return /\b(?:task|work|request|operation|change)\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|finished|successful)\b/iu.test(text)
    || /^\s*(?:done|completed|finished|success)\b[.!]?\s*$/iu.test(text);
}

export function requestsInput(text) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (/\b(?:need|requires?|missing|blocked|cannot continue|can't continue|please provide|please supply|please clarify)\b[^.!?]{0,160}[.!?]?$/u.test(normalized)) {
    return true;
  }
  const last = normalized.split(/(?<=[.!?])\s+/u).at(-1) ?? normalized;
  if (!last.endsWith('?')) return false;
  if (/^(?:how|what) can i help\b|^what would you like me to (?:help|assist)\b|^is there anything (?:else )?(?:i can|you(?:'d| would) like me to)\b|^would you like me to\b/u.test(last)) {
    return false;
  }
  return /^(?:which|what|where|when|who)\b|^(?:how|why) should\b|^(?:should|may|can) i\b|^do you want me to\b/u.test(last);
}

function lostActiveTask(active, text) {
  if (!(active.recovery?.actions?.length > 0)) return false;
  const normalized = text.trim().toLowerCase();
  return /\bi(?:'m| am) (?:ready|here) to help\b/u.test(normalized)
    && /\bwhat would you like me to (?:help|assist)\b/u.test(normalized);
}
