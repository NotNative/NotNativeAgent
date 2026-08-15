// SPDX-License-Identifier: Apache-2.0

const TRUNCATED = new Set(['length', 'max_tokens', 'max_output_tokens']);
const TOOL_SIGNAL = new Set(['tool_calls', 'function_call']);

export function evaluateCompletion(active, text, work = null) {
  const finishReason = String(active.finishReason ?? '').toLowerCase();
  if (TRUNCATED.has(finishReason)) {
    return Object.freeze({ disposition: 'continue', category: 'truncated_output', progressEvidence: text });
  }
  if (TOOL_SIGNAL.has(finishReason) && (active.toolAssembler?.size ?? 0) === 0) {
    return Object.freeze({ disposition: 'continue', category: 'missing_tool_call', progressEvidence: null });
  }
  if (lostActiveTask(active, text)) {
    return Object.freeze({ disposition: 'continue', category: 'task_context_lost', progressEvidence: null });
  }
  const workGate = unfinishedWorkGate(work, text);
  if (workGate) return workGate;
  if ((active.unresolvedToolFailures?.length ?? 0) > 0) {
    if (requestsInput(text)) return Object.freeze({ disposition: 'needs_input', category: 'blocked_after_tool_failure' });
    if (claimsCompletion(text)) {
      return Object.freeze({ disposition: 'continue', category: 'unresolved_tool_failure', progressEvidence: null });
    }
  }
  if (requestsInput(text)) return Object.freeze({ disposition: 'needs_input', category: 'model_requested_input' });
  return Object.freeze({ disposition: 'completed', category: 'settled_output' });
}

function unfinishedWorkGate(work, text) {
  const tasks = Array.isArray(work?.tasks) ? work.tasks : [];
  const unfinished = tasks.filter((task) => task.status !== 'completed');
  const goalActive = work?.goal?.status === 'active';
  if (!goalActive && unfinished.length === 0) return null;
  const blocked = unfinished.filter((task) => task.status === 'blocked');
  if (blocked.length > 0 && requestsInput(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'blocked_work_requested_input' });
  }
  const summary = `${unfinished.length} unfinished task(s); goal ${goalActive ? 'active' : 'settled'}; work revision ${work?.revision ?? 0}`;
  return Object.freeze({
    disposition: 'continue', category: 'unfinished_conversation_work', required: true,
    progressEvidence: summary,
    hint: 'The durable goal or task list is still open, so this turn cannot finish. Read work.status, complete every remaining task with concrete evidence, then complete the goal. If operator input is genuinely required, mark the relevant task blocked with the exact reason and ask one concrete question. Do not offer optional follow-up work or ask whether to continue.',
  });
}

export function partialOutputProgress(text) {
  return Object.freeze({
    kind: 'partial_model_output', checkpoint: 'partial_assistant_message_committed',
    summary: Object.freeze({ output_bytes: Buffer.byteLength(text, 'utf8') }),
  });
}

function claimsCompletion(text) {
  // Require an explicit task noun or a terse terminal-only acknowledgement; ordinary optimism is not completion.
  return /\b(?:task|work|request|operation|change)\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|finished|successful)\b/iu.test(text)
    || /^\s*(?:done|completed|finished|success)\b[.!]?\s*$/iu.test(text);
}

export function requestsInput(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (!normalized) return false;
  // Only the bounded output tail can represent the model's current terminal request; this also bounds regex work.
  const tail = normalized.slice(-512);
  if (/\b(?:need|requires?|missing|blocked|cannot continue|can't continue|please provide|please supply|please clarify)\b[^.!?]{0,160}[.!?]?$/u.test(tail)) {
    return true;
  }
  const last = tail.split(/(?<=[.!?])\s+/u).at(-1) ?? tail;
  if (!last.endsWith('?')) return false;
  if (/^(?:how|what) can i help\b|^what would you like me to (?:help|assist)\b|^is there anything (?:else )?(?:i can|you(?:'d| would) like me to)\b|^would you like me to\b/u.test(last)) {
    return false;
  }
  return /^(?:which|what|where|when|who)\b|^(?:how|why) should\b|^(?:should|may|can) i\b|^do you want me to\b/u.test(last);
}

function lostActiveTask(active, text) {
  if (!(active.recovery?.actions?.length > 0)) return false;
  const normalized = text.trim().toLowerCase();
  // Both halves together identify a reset-style greeting, and only after recovery has already begun.
  return /\bi(?:'m| am) (?:ready|here) to help\b/u.test(normalized)
    && /\bwhat would you like me to (?:help|assist)\b/u.test(normalized);
}
