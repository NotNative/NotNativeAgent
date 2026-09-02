// SPDX-License-Identifier: Apache-2.0

const TRUNCATED = new Set(['length', 'max_tokens', 'max_output_tokens']);
const TOOL_SIGNAL = new Set(['tool_calls', 'function_call']);
const SEQUENCING_WORDS = new Set(['also', 'first', 'just', 'next', 'now', 'then']);

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
  const declaration = active.terminalDeclaration ?? null;
  const terminalBlocker = reportsTerminalBlocker(text);
  const workGate = unfinishedWorkGate(work, text, terminalBlocker, declaration);
  if (workGate) return workGate;
  if ((active.unresolvedToolFailures?.length ?? 0) > 0) {
    if (declaration?.outcome === 'needs_input') return Object.freeze({ disposition: 'needs_input', category: 'blocked_after_tool_failure' });
    if (declaration?.outcome === 'blocked') return Object.freeze({ disposition: 'blocked', category: 'terminal_tool_blocker' });
    if (declaration?.outcome === 'completed' || claimsCompletion(text)) {
      return Object.freeze({ disposition: 'continue', category: 'unresolved_tool_failure', progressEvidence: null });
    }
    return Object.freeze({ disposition: 'blocked', category: 'unresolved_tool_blocker' });
  }
  if ((active.correctableToolFailures?.length ?? 0) > 0 && claimsCompletion(text)
    && declaration?.outcome !== 'completed' && !exactRequestWasBounded(active)) {
    return Object.freeze({ disposition: 'continue', category: 'uncorrected_tool_request', progressEvidence: null });
  }
  const visualGate = visualEvidenceGate(active.visualEvidence, text);
  if (visualGate) return visualGate;
  if (requestsInput(text)) return Object.freeze({ disposition: 'needs_input', category: 'model_requested_input' });
  if (terminalBlocker) return Object.freeze({ disposition: 'blocked', category: 'terminal_blocker' });
  if (hasUnfulfilledCompletionObligation(active)) {
    return Object.freeze({
      disposition: 'continue', category: 'unfulfilled_completion_obligation', progressEvidence: null,
      hint: 'A prior response committed to continuing the work, but no successful tool evidence followed that commitment. Continue with an appropriate tool now, or ask one concrete question if operator input is genuinely required.',
    });
  }
  if (declaration?.outcome === 'needs_input') return Object.freeze({ disposition: 'needs_input', category: 'declared_input_required' });
  if (declaration?.outcome === 'blocked') return Object.freeze({ disposition: 'blocked', category: 'declared_terminal_blocker' });
  if (declaration?.outcome === 'completed') return Object.freeze({ disposition: 'completed', category: 'declared_completion' });
  if (promisesFutureAction(text)) {
    return Object.freeze({
      disposition: 'continue', category: 'future_action_pledge', progressEvidence: text,
      obligation: Object.freeze({
        kind: 'future_action', evidenceRevision: active.toolEvidenceRevision ?? 0,
      }),
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
  const words = modelOutputWords(String(text ?? '').trim().slice(-2_048));
  for (let index = 0; index < words.length; index += 1) {
    const cursor = futureCommitmentCursor(words, index);
    if (cursor === null) continue;
    let action = cursor;
    while (SEQUENCING_WORDS.has(words[action])) action += 1;
    if (words[action] === 'not' || words[action] === 'never' || isTerminalAvailability(words, action)) continue;
    if (words[action]) return true;
  }
  return false;
}

function modelOutputWords(text) {
  return text.replace(/’/gu, "'").replace(/[\p{P}\p{S}]+/gu, (value) => value.includes("'") ? value : ' ')
    .toLowerCase().match(/[a-z]+(?:'[a-z]+)?/gu) ?? [];
}

function futureCommitmentCursor(words, index) {
  if (words[index] === "i'll") return index + 1;
  if (words[index] === 'i' && words[index + 1] === 'will') return index + 2;
  if (words[index] === 'i' && words[index + 1] === 'am'
    && words[index + 2] === 'going' && words[index + 3] === 'to') return index + 4;
  if (words[index] === "i'm" && words[index + 1] === 'going' && words[index + 2] === 'to') return index + 3;
  if (words[index] === 'let' && words[index + 1] === 'me') return index + 2;
  return null;
}

function isTerminalAvailability(words, index) {
  const current = words[index];
  const next = words[index + 1];
  if (['remain', 'stay'].includes(current) && ['available', 'ready', 'here'].includes(next)) return true;
  if (current === 'be' && ['available', 'ready', 'here'].includes(next)) return true;
  return ['help', 'assist'].includes(current) && ['if', 'with', 'you'].includes(next);
}

function hasUnfulfilledCompletionObligation(active) {
  const obligation = active.completionObligation;
  if (!obligation || obligation.kind !== 'future_action') return false;
  return (active.toolEvidenceRevision ?? 0) <= obligation.evidenceRevision;
}

function exactRequestWasBounded(active) {
  return active.recovery?.actions?.some((item) => item.action === 'block_exact_request') === true;
}

function claimsCompletion(text) {
  // Compatibility: legacy providers can omit turn.finish during migration.
  return /\b(?:task|work|request|operation|change)\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|finished|successful)\b/iu.test(text)
    || /^\s*(?:done|completed|finished|success)\b[.!]?\s*$/iu.test(text);
}

function unfinishedWorkGate(work, text, terminalBlocker, declaration) {
  const tasks = Array.isArray(work?.tasks) ? work.tasks : [];
  if (work?.pendingCompletion) {
    return Object.freeze({ disposition: 'completed', category: 'pending_work_completion' });
  }
  const unfinished = tasks.filter((task) => task.status !== 'completed');
  const goalActive = work?.goal?.status === 'active';
  const goalBlocked = work?.goal?.status === 'blocked';
  if (goalBlocked) {
    if (declaration?.outcome === 'needs_input' || requestsInput(text)) {
      return Object.freeze({ disposition: 'needs_input', category: 'blocked_work_requested_input' });
    }
    return Object.freeze({ disposition: 'blocked', category: 'recorded_work_blocker' });
  }
  if (!goalActive && unfinished.length === 0) return null;
  if (requestsOperatorAuthorization(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'operator_authorization_requested' });
  }
  const blocked = unfinished.filter((task) => task.status === 'blocked');
  if (blocked.length > 0 && requestsInput(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'blocked_work_requested_input' });
  }
  if (declaration?.outcome === 'needs_input' || requestsInput(text)) {
    return Object.freeze({ disposition: 'needs_input', category: 'active_work_requested_input' });
  }
  if (terminalBlocker) {
    return Object.freeze({
      disposition: 'continue', category: 'unrecorded_work_blocker', required: true,
      progressEvidence: `goal active; ${unfinished.length} unfinished task(s); work revision ${work?.revision ?? 0}`,
      hint: 'The prior response reported a terminal blocker while durable work remained active. Update each unfinished task truthfully, then set goal_status to blocked with goal_blocked_reason using work.plan. If operator input can resolve the blocker, ask one concrete question instead.',
    });
  }
  const summary = `${unfinished.length} unfinished task(s); goal ${goalActive ? 'active' : 'settled'}; work revision ${work?.revision ?? 0}`;
  return Object.freeze({
    disposition: 'continue', category: 'unfinished_conversation_work', required: true,
    progressEvidence: summary,
    hint: 'An optional durable plan is active and still unfinished. Continue the work or use work.plan to update the complete task snapshot with concrete evidence; do not stop merely because a milestone changed. If operator input is genuinely required, ask one concrete question and mark the relevant task blocked when possible. Do not offer optional follow-up work or ask whether to continue.',
  });
}

function reportsTerminalBlocker(text) {
  const tail = String(text ?? '').trim().toLowerCase().slice(-1_024);
  if (!tail) return false;
  const statement = tail.split(/(?<=[.!?])\s+/u).at(-1) ?? tail;
  if (promisesFutureAction(statement)) return false;
  return /\b(?:i|we)\s+(?:cannot|can't|am unable to|are unable to)\s+(?:complete|finish|continue|proceed|fulfil|fulfill)\b/u.test(statement)
    || /\b(?:i|we)(?:'m| am|'re| are)\s+blocked\s+from\s+(?:completing|finishing|continuing|proceeding)\b/u.test(statement)
    || /\b(?:task|work|request|operation|goal)\s+(?:is|remains)\s+blocked\b/u.test(statement);
}

export function partialOutputProgress(text) {
  return Object.freeze({
    kind: 'partial_model_output', checkpoint: 'partial_assistant_message_committed',
    summary: Object.freeze({ output_bytes: Buffer.byteLength(text, 'utf8') }),
  });
}

export function requestsInput(text) {
  const normalized = String(text ?? '').trim().toLowerCase();
  if (!normalized) return false;
  // Only the bounded output tail can represent the model's current terminal request; this also bounds regex work.
  const tail = normalized.slice(-512);
  if (/\b(?:please provide|please supply|please clarify)\b[^.!?]{0,160}[.!?]?$/u.test(tail)) {
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
