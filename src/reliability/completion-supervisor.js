// SPDX-License-Identifier: Apache-2.0

const TRUNCATED = new Set(['length', 'max_tokens', 'max_output_tokens']);
const TOOL_SIGNAL = new Set(['tool_calls', 'function_call']);
const ACTION_VERB = '(?:check|inspect|verify|read|search|fetch|look\\s+up|write|create|edit|modify|fix|implement|build|run|test|install|start|open|update|investigate|review)';
const FUTURE_ACTION = new RegExp(
  `(?:\\b(?:i(?:'ll| will)|i(?:'m| am) going to)\\s+(?:first\\s+|now\\s+|next\\s+)?${ACTION_VERB}\\b|\\blet me\\s+${ACTION_VERB}\\b)`,
  'iu',
);

export function evaluateCompletion(active, text, work = null) {
  const finishReason = String(active.finishReason ?? '').toLowerCase();
  if (TRUNCATED.has(finishReason) || reachedReportedOutputCeiling(active)) {
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
  const visualGate = visualEvidenceGate(active.visualEvidence, text);
  if (visualGate) return visualGate;
  if (requestsInput(text)) return Object.freeze({ disposition: 'needs_input', category: 'model_requested_input' });
  if (promisesFutureAction(text)) {
    return Object.freeze({
      disposition: 'continue', category: 'future_action_pledge', progressEvidence: text,
      hint: 'The prior response promised a concrete next action but did not perform it. Continue now by taking that action with an appropriate tool; do not merely restate the promise.',
    });
  }
  return Object.freeze({ disposition: 'completed', category: 'settled_output' });
}

function visualEvidenceGate(evidence, text) {
  if (!evidence || evidence.verdict === 'pass' || !claimsVisualPass(text)) return null;
  if (evidence.verdict === 'minor_caveat' && qualifiesVisualCaveat(text)) return null;
  return Object.freeze({
    disposition: 'continue', category: 'visual_evidence_conflict', progressEvidence: null,
    hint: 'The latest image.inspect verdict does not support an absolute visual-pass claim. DOM inspection, console output, and textual reasoning cannot supersede visible evidence. Either obtain a newer screenshot and image.inspect verdict after a material change, or finish with a qualified description of the remaining visible caveat. Do not claim that artifacts are absent without newer visual evidence.',
  });
}

function claimsVisualPass(text) {
  const tail = String(text ?? '').slice(-4_096);
  return /\b(?:no|without)\s+(?:real\s+)?(?:visible\s+)?(?:artifact|defect|issue|problem|seam|error)s?\b/iu.test(tail)
    || /\b(?:visually|render(?:ed|s|ing)?)\s+(?:is\s+|was\s+)?(?:clean|correct|flawless|verified|perfect)\b/iu.test(tail)
    || /\bvisual (?:inspection|verification)\s+(?:confirms?|confirmed|shows?|showed)\b[^.!?]{0,120}\b(?:no|clean|correct|pass)/iu.test(tail)
    || /\b(?:all|every)\s+(?:tested\s+)?(?:view|state|viewport|screenshot)s?\s+(?:now\s+)?pass(?:es|ed)?\b/iu.test(tail);
}

function qualifiesVisualCaveat(text) {
  const tail = String(text ?? '').slice(-4_096);
  return /\b(?:minor\s+)?(?:caveat|limitation|imperfection|artifact|issue|defect|seam)s?\b/iu.test(tail)
    && /\b(?:remain(?:s|ing)?|still|except|although|however|but|with)\b/iu.test(tail);
}

function reachedReportedOutputCeiling(active) {
  const limit = active.attemptOutputLimitTokens;
  if (!Number.isSafeInteger(limit) || limit < 1) return false;
  const usage = active.attemptUsage;
  if (!usage || typeof usage !== 'object') return false;
  const output = ['completion_tokens', 'output_tokens', 'outputTokens']
    .map((key) => usage[key]).find((value) => Number.isSafeInteger(value) && value >= 0);
  return Number.isSafeInteger(output) && output >= limit;
}

function promisesFutureAction(text) {
  const tail = String(text ?? '').trim().slice(-1_024);
  return tail.length > 0 && FUTURE_ACTION.test(tail);
}

function unfinishedWorkGate(work, text) {
  const tasks = Array.isArray(work?.tasks) ? work.tasks : [];
  const unfinished = tasks.filter((task) => task.status !== 'completed');
  const goalActive = work?.goal?.status === 'active';
  if (!goalActive && unfinished.length === 0) return null;
  if (requestsOperatorAuthorization(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'operator_authorization_requested' });
  }
  const blocked = unfinished.filter((task) => task.status === 'blocked');
  if (blocked.length > 0 && requestsInput(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'blocked_work_requested_input' });
  }
  if (requestsInput(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'active_work_requested_input' });
  }
  const summary = `${unfinished.length} unfinished task(s); goal ${goalActive ? 'active' : 'settled'}; work revision ${work?.revision ?? 0}`;
  return Object.freeze({
    disposition: 'continue', category: 'unfinished_conversation_work', required: true,
    progressEvidence: summary,
    hint: 'An optional durable plan is active and still unfinished. Continue the work or use work.plan to update the complete task snapshot with concrete evidence; do not stop merely because a milestone changed. If operator input is genuinely required, ask one concrete question and mark the relevant task blocked when possible. Do not offer optional follow-up work or ask whether to continue.',
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

function requestsOperatorAuthorization(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const tail = normalized.slice(-512);
  const last = tail.split(/(?<=[.!?])\s+/u).at(-1) ?? tail;
  if (!last.endsWith('?')) return false;
  return /^(?:do you )?want me to\b|^would you like me to\b|^(?:should|shall|may|can) i\b|^would you rather\b/u.test(last);
}

function lostActiveTask(active, text) {
  if (!(active.recovery?.actions?.length > 0)) return false;
  const normalized = text.trim().toLowerCase();
  // Both halves together identify a reset-style greeting, and only after recovery has already begun.
  return /\bi(?:'m| am) (?:ready|here) to help\b/u.test(normalized)
    && /\bwhat would you like me to (?:help|assist)\b/u.test(normalized);
}
