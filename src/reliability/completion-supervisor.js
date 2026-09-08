// SPDX-License-Identifier: Apache-2.0
import { reachedOutputCeiling } from './output-headroom.js';

const TOOL_SIGNAL = new Set(['tool_calls', 'function_call']);
const SEQUENCING_WORDS = new Set(['also', 'first', 'just', 'next', 'now', 'then']);

export function evaluateCompletion(active, text, work = null) {
  const finishReason = String(active.finishReason ?? '').toLowerCase();
  if (reachedOutputCeiling({
    finishReason, outputLimitTokens: active.attemptOutputLimitTokens, usage: active.attemptUsage,
  })) {
    return Object.freeze({ disposition: 'continue', category: 'truncated_output', progressEvidence: text });
  }
  if (TOOL_SIGNAL.has(finishReason) && (active.toolAssembler?.size ?? 0) === 0) {
    return Object.freeze({ disposition: 'continue', category: 'missing_tool_call', progressEvidence: null });
  }
  const declaration = active.terminalDeclaration ?? null;
  const workGate = unfinishedWorkGate(work, declaration);
  if (workGate) return workGate;
  const reviewerGate = reviewerCompletionGate(active.reviewerCompletion, declaration);
  if (reviewerGate) return reviewerGate;
  if ((active.unresolvedToolFailures?.length ?? 0) > 0) {
    if (declaration?.outcome === 'needs_input') return Object.freeze({ disposition: 'needs_input', category: 'blocked_after_tool_failure' });
    if (declaration?.outcome === 'blocked') return Object.freeze({ disposition: 'blocked', category: 'terminal_tool_blocker' });
    if (['incomplete', 'failed'].includes(declaration?.outcome)) {
      return Object.freeze({ disposition: declaration.outcome, category: 'declared_tool_failure' });
    }
    if (!declaration) return Object.freeze({ disposition: 'incomplete', category: 'terminal_declaration_missing' });
    return Object.freeze({ disposition: 'continue', category: 'unresolved_tool_failure', required: true, progressEvidence: null });
  }
  if ((active.correctableToolFailures?.length ?? 0) > 0
    && !['blocked', 'incomplete', 'failed', 'needs_input'].includes(declaration?.outcome)
    && !exactRequestWasBounded(active)) {
    return Object.freeze({ disposition: 'continue', category: 'uncorrected_tool_request', required: true, progressEvidence: null });
  }
  const visualGate = visualEvidenceGate(active.visualEvidence, declaration);
  if (visualGate) return visualGate;
  if (declaration?.outcome === 'needs_input') return Object.freeze({ disposition: 'needs_input', category: 'declared_input_required' });
  if (declaration?.outcome === 'blocked') return Object.freeze({ disposition: 'blocked', category: 'declared_terminal_blocker' });
  if (declaration?.outcome === 'incomplete') return Object.freeze({ disposition: 'incomplete', category: 'declared_incomplete' });
  if (declaration?.outcome === 'failed') return Object.freeze({ disposition: 'failed', category: 'declared_failure' });
  if (declaration?.outcome === 'completed') return Object.freeze({ disposition: 'completed', category: 'declared_completion' });
  // Invariant: a clean provider stop completes the turn when no structured gate remains.
  // Tool use alone never creates a second terminal protocol or a model self-attestation duty.
  return Object.freeze({ disposition: 'completed', category: 'settled_output' });
}

function reviewerCompletionGate(state, declaration) {
  if (state?.schema !== 'nna.reviewer-completion.v1' || state.unresolved_count < 1) return null;
  if (declaration?.outcome === 'needs_input') {
    return Object.freeze({ disposition: 'needs_input', category: 'reviewed_tool_outcome_needs_input' });
  }
  if (['blocked', 'incomplete', 'failed'].includes(declaration?.outcome)) {
    return Object.freeze({ disposition: declaration.outcome, category: `reviewed_tool_outcome_${declaration.outcome}` });
  }
  const summary = state.unresolved.slice(0, 16)
    .map((item) => `${item.tool}:${item.state}:${item.effect_certainty}`).join('; ');
  return Object.freeze({
    disposition: 'continue', category: 'unresolved_reviewed_tool_outcome', required: true,
    progressEvidence: summary,
    hint: 'The reviewer ledger contains unresolved tool outcomes. Retry or verify each operation. Otherwise, use turn_finish with a truthful non-completed outcome.',
  });
}

function visualEvidenceGate(evidence, declaration) {
  if (!evidence || evidence.verdict === 'pass' || declaration?.outcome !== 'completed') return null;
  if (evidence.verdict === 'minor_caveat') return null;
  return Object.freeze({
    disposition: 'continue', category: 'visual_evidence_conflict', required: true, progressEvidence: null,
    hint: 'The latest image_inspect verdict does not support an absolute visual-pass claim. DOM inspection, console output, and textual reasoning cannot supersede visible evidence. Either obtain a newer screenshot and image_inspect verdict after a material change, or finish with a qualified description of the remaining visible caveat. Do not claim that artifacts are absent without newer visual evidence.',
  });
}

function claimsVisualPass(text) {
  const tail = String(text ?? '').slice(-4_096);
  return /\b(?:no|without)\s+(?:real\s+)?(?:visible\s+)?(?:artifact|defect|issue|problem|seam|error)s?\b/iu.test(tail)
    || /\b(?:visually|render(?:ed|s|ing)?)\s+(?:is\s+|was\s+)?(?:clean|correct|flawless|verified|perfect)\b/iu.test(tail)
    || /\bvisual (?:inspection|verification)\s+(?:confirms?|confirmed|shows?|showed)\b[^.!?]{0,120}\b(?:no|clean|correct|pass)/iu.test(tail)
    || /\b(?:all|every)\s+(?:tested\s+)?(?:view|state|viewport|screenshot)s?\s+(?:now\s+)?pass(?:es|ed)?\b/iu.test(tail);
}

function promisesFutureAction(text) {
  const words = modelOutputWords(String(text ?? '').trim().slice(-2_048));
  for (let index = 0; index < words.length; index += 1) {
    const cursor = futureCommitmentCursor(words, index);
    if (cursor === null) continue;
    let action = cursor;
    while (SEQUENCING_WORDS.has(words[action])) action += 1;
    if (words[action] === 'not' || words[action] === 'never'
      || isTerminalAvailability(words, action) || isOperatorDirectedClosing(words, index, action)) continue;
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

function isOperatorDirectedClosing(words, commitmentIndex, actionIndex) {
  // Why: "let me know" asks the operator to communicate; it is not a promise that the
  // model will perform unfinished task work after the turn ends.
  return words[commitmentIndex] === 'let' && words[commitmentIndex + 1] === 'me'
    && words[actionIndex] === 'know';
}

function exactRequestWasBounded(active) {
  return active.recovery?.actions?.some((item) => item.action === 'block_exact_request') === true;
}

function claimsCompletion(text) {
  // Why: language matching is retained only as content-free telemetry for model-quality
  // diagnosis. It must never choose or override a terminal disposition.
  return /\b(?:task|work|request|operation|change)\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|finished|successful)\b/iu.test(text)
    || /^\s*(?:done|completed|finished|success)\b[.!]?\s*$/iu.test(text);
}

function unfinishedWorkGate(work, declaration) {
  if (work?.pendingCompletion) {
    // Why: the final assistant response is the deliverable that commits staged work completion.
    // Requiring a second declaration would make bookkeeping a liveness dependency.
    return null;
  }
  const goalBlocked = work?.goal?.status === 'blocked';
  if (goalBlocked) {
    if (declaration?.outcome === 'needs_input') {
      return Object.freeze({ disposition: 'needs_input', category: 'blocked_work_requested_input' });
    }
    return Object.freeze({ disposition: 'blocked', category: 'recorded_work_blocker' });
  }
  // Why: conversation work is durable across authenticated turns. An active goal or
  // unfinished task is context for the next turn, not proof that this provider response
  // is incomplete. Only current-turn reviewer, tool, visual, or transport evidence may
  // force an immediate continuation.
  return null;
}

export function completionAdvisories(text) {
  return Object.freeze([
    claimsCompletion(text) ? 'completion_claim' : null,
    requestsInput(text) ? 'input_request_language' : null,
    reportsTerminalBlocker(text) ? 'terminal_blocker_language' : null,
    promisesFutureAction(text) ? 'future_action_language' : null,
    claimsVisualPass(text) ? 'visual_pass_language' : null,
    lostActiveTaskLanguage(text) ? 'task_context_reset_language' : null,
  ].filter(Boolean));
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

function lostActiveTaskLanguage(text) {
  const normalized = text.trim().toLowerCase();
  return /\bi(?:'m| am) (?:ready|here) to help\b/u.test(normalized)
    && /\bwhat would you like me to (?:help|assist)\b/u.test(normalized);
}
