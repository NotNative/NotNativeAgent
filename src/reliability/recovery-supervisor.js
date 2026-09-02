// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { randomInt } from 'node:crypto';
import { boundedProviderRetryDelay } from './retry-after.js';

const MAX_ACTION_HISTORY = 256;
const MAX_PROGRESS_RECORDS = 4_096;
const MAX_EPISODES = 4_096;
const MAX_EXHAUSTION_EVIDENCE = 32;
const MAX_REASON_CODES = 16;
const MAX_REPEATED_FINGERPRINTS = 16;
const MIN_USEFUL_CHECKPOINT_CHARACTERS = 160;
const MAX_CHECKPOINT_CHARACTERS = 2_400;
const CHECKPOINT_HEAD_RATIO = 0.7;
const CHECKPOINT_SEPARATOR_RESERVE = 32;
const MIN_EXACT_NO_EFFECT_LIMIT = 3;
const MIN_DURABLE_WORK_CONTINUATION_LIMIT = 6;
const EMPTY_COMPLETION_BASE_DELAY_MS = 250;
const EMPTY_COMPLETION_MAX_DELAY_MS = 30_000;
const BOUNDED_COMPLETION_CATEGORIES = new Set([
  'missing_tool_call', 'task_context_lost', 'unresolved_tool_failure',
  'visual_evidence_conflict',
]);

export class RecoverySupervisor {
  #episodes = new Map();
  #progress = new Map();
  #actions = [];
  #lastContextLimitTokens = null;

  constructor(options = {}) {
    this.localLimit = options.localLimit ?? 3;
    this.ladder = options.ladder ?? ['nudge', 'compact'];
    this.exactNoEffectLimit = options.exactNoEffectLimit
      ?? Math.max(MIN_EXACT_NO_EFFECT_LIMIT, this.localLimit);
    this.#actions = (options.restoredActions ?? []).slice(-MAX_ACTION_HISTORY);
  }

  providerRetry(category, attempt, partial, suggestedDelayMs = null) {
    if (partial || attempt >= this.localLimit - 1) return Object.freeze({ retry: false, exhausted: true });
    const delayMs = boundedProviderRetryDelay(boundedDelay(attempt), suggestedDelayMs);
    const action = this.#record(category, 'retry_provider', attempt + 1, {
      delayMs, target: 'current_route', partial: false,
    });
    return Object.freeze({ retry: true, delayMs, action });
  }

  contextLimit(partial, scale = 0.5, evidence = {}) {
    const category = 'provider_context_limit';
    const count = this.#episodes.get(category) ?? 0;
    const estimatedInputTokens = positiveInteger(evidence.estimatedInputTokens);
    const minimumReduction = this.#lastContextLimitTokens === null ? 0
      : Math.max(64, Math.floor(this.#lastContextLimitTokens * 0.01));
    const materiallySmaller = count === 0 || (
      estimatedInputTokens !== null && this.#lastContextLimitTokens !== null
      && this.#lastContextLimitTokens - estimatedInputTokens >= minimumReduction
    );
    if (partial || count >= 2 || !materiallySmaller) {
      return Object.freeze({ continue: false, exhausted: true });
    }
    const retryScale = count === 0 ? scale : Math.max(0.0625, scale / 2);
    const previousInputTokens = this.#lastContextLimitTokens;
    this.#lastContextLimitTokens = estimatedInputTokens;
    this.#episodes.set(category, count + 1);
    const action = this.#record(category, 'compact_context_limit', count + 1, {
      target: 'current_route', partial: false, scale: retryScale,
      estimated_input_tokens: estimatedInputTokens,
      previous_estimated_input_tokens: previousInputTokens,
    });
    return Object.freeze({ continue: true, scale: retryScale, action });
  }

  reasoningOnly() {
    return this.#record('reasoning_only_output', 'retry_without_reasoning', 1, {
      target: 'current_route', partial: false,
    });
  }

  reasoningTruncated() {
    return this.#record('reasoning_truncated_before_action', 'retry_reasoning_to_action', 1, {
      target: 'current_route', partial: false,
    });
  }

  providerUnusableCompletion(detail = {}, options = {}) {
    const routeFingerprint = options.routeIdentity ? digest(options.routeIdentity) : null;
    const episode = episodeKey('provider_unusable_completion', routeFingerprint);
    const count = (this.#episodes.get(episode) ?? 0) + 1;
    if (!this.#episodes.has(episode) && this.#episodes.size >= MAX_EPISODES) {
      this.#episodes.delete(this.#episodes.keys().next().value);
    }
    this.#episodes.set(episode, count);
    const delayMs = emptyCompletionDelay(count);
    const action = this.#record('provider_unusable_completion', 'retry_provider_completion', count, {
      ...detail,
      delay_ms: delayMs, target: 'current_route', partial: false,
      ...(routeFingerprint ? { route_fingerprint: routeFingerprint } : {}),
    });
    // Why: a content-free provider completion says nothing about task intent.
    // Keep the turn cancellable and observable instead of asking the operator to repair provider output.
    return Object.freeze({ continue: true, progress: false, count, delayMs, action });
  }

  providerOutputObserved() {
    for (const key of this.#episodes.keys()) {
      if (key === 'provider_unusable_completion' || key.startsWith('provider_unusable_completion\0')) {
        this.#episodes.delete(key);
      }
    }
  }

  noProgress(category, evidence = null, detail = {}, options = {}) {
    const observedDetail = evidenceDetail(evidence, detail);
    if (evidence && this.observeProgress(evidenceValue(evidence), observedDetail)) {
      this.#episodes.clear();
      return Object.freeze({ continue: true, progress: true, action: null });
    }
    const episode = episodeKey(category, options.failureFingerprint, observedDetail);
    const count = (this.#episodes.get(episode) ?? 0) + 1;
    if (!this.#episodes.has(episode) && this.#episodes.size >= MAX_EPISODES) {
      this.#episodes.delete(this.#episodes.keys().next().value);
    }
    this.#episodes.set(episode, count);
    const limit = terminalNoProgressLimit(category, this.localLimit, this.exactNoEffectLimit);
    if (limit !== null && count >= limit) {
      return Object.freeze({ continue: false, exhausted: true, count });
    }
    const action = recoveryAction(count, this.localLimit, this.ladder, options.allowCompaction);
    return Object.freeze({
      continue: true, progress: false, count,
      action: this.#record(category, action, count, {
        ...repeatedEvidenceDetail(observedDetail),
        ...(options.failureFingerprint ? { failure_fingerprint: options.failureFingerprint } : {}),
      }),
    });
  }

  continuation(category, evidence = null, detail = {}, options = {}) {
    const plan = this.noProgress(category, evidence, detail, options);
    if (!plan.progress) return plan;
    return Object.freeze({
      ...plan,
      action: this.#record(category, 'retry_continuation', 1, { progress: true }),
    });
  }

  observeProgress(value, detail = {}) {
    const fingerprint = digest(value);
    if (this.#progress.has(fingerprint)) return false;
    if (this.#progress.size >= MAX_PROGRESS_RECORDS) this.#progress.delete(this.#progress.keys().next().value);
    this.#progress.set(fingerprint, progressRecord(fingerprint, value, detail));
    return true;
  }

  externalEvidence(value) {
    this.observeProgress(`external:${value}`);
    this.#episodes.clear();
  }

  behavioralCheckpoint(category, action, count, detail = {}) {
    return this.#record(category, action, count, detail);
  }

  exhaustion(records = [], reasonCodes = []) {
    const evidence = [...this.#progress.values()].slice(-MAX_EXHAUSTION_EVIDENCE);
    const checkpoint = evidence.at(-1)?.checkpoint ?? 'turn_start';
    return Object.freeze({
      code: 'recovery_exhausted', retryable: true, partial: evidence.length > 0,
      progress_fingerprints: this.#progress.size,
      completed_progress: Object.freeze({
        unique_evidence_count: this.#progress.size,
        fingerprints: Object.freeze(evidence.map((item) => item.fingerprint)),
        evidence: Object.freeze(evidence),
      }),
      recovery_actions: Object.freeze(this.#actions.slice(-MAX_EXHAUSTION_EVIDENCE)),
      last_checkpoint: checkpoint,
      last_verified_checkpoint: checkpoint,
      remaining_work: 'model continuation did not demonstrate forward progress',
      resume_condition: 'new authenticated input or changed external evidence',
      reason_codes: Object.freeze([...new Set(reasonCodes.filter(Boolean))].slice(0, MAX_REASON_CODES)),
      side_effect_certainty: effectCertainty(records),
    });
  }

  get actions() {
    return Object.freeze([...this.#actions]);
  }

  #record(category, action, count, detail = {}) {
    const record = Object.freeze({
      category, action, count, ...detail, timestamp: new Date().toISOString(),
    });
    this.#actions.push(record);
    if (this.#actions.length > MAX_ACTION_HISTORY) this.#actions.shift();
    return record;
  }

}

function episodeKey(category, failureFingerprint, detail = {}) {
  if (failureFingerprint) return `${category}\0${failureFingerprint}`;
  const requestFingerprints = detail?.summary?.request_fingerprints;
  if (!Array.isArray(requestFingerprints) || requestFingerprints.length === 0) return category;
  const stableRequests = [...new Set(requestFingerprints.filter((item) => typeof item === 'string' && item.length > 0))].sort();
  return stableRequests.length > 0 ? `${category}\0requests\0${stableRequests.join('\0')}` : category;
}

function repeatedEvidenceDetail(detail) {
  const fingerprints = detail?.summary?.request_fingerprints;
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) return {};
  return { repeated_request_fingerprints: Object.freeze(fingerprints.slice(0, MAX_REPEATED_FINGERPRINTS)) };
}

export function recoveryExhaustionText(detail, options = {}) {
  if (detail.exhaustion_category === 'model_step_limit') {
    const steps = Number.isInteger(detail.exhaustion_count) ? ` after ${detail.exhaustion_count} model steps` : '';
    return `The configured model-step ceiling was reached${steps}. Completed work and diagnostics remain preserved.\n\n`
      + 'This explicit runtime boundary ended the turn. Increase the configured ceiling or start a continuation turn if more work is intended.';
  }
  if (detail.exhaustion_category === 'empty_output') {
    const checkpoint = usefulAssistantCheckpoint(options.transcript, options.turnId);
    const attempts = Number.isInteger(detail.exhaustion_count) ? ` after ${detail.exhaustion_count} attempts` : '';
    const preserved = checkpoint
      ? `\n\nLast useful assistant checkpoint:\n${checkpoint}`
      : '';
    return `The model returned no usable continuation${attempts}, so automatic recovery is parked. `
      + `Completed tool effects and diagnostics remain preserved.${preserved}\n\n`
      + 'The turn remains active. Provide direction to resume from the preserved activity, or cancel the turn.';
  }
  if (detail.exhaustion_category === 'tool_no_progress') {
    const attempts = Number.isInteger(detail.exhaustion_count) ? ` after ${detail.exhaustion_count} repetitions` : '';
    return `The same failure condition, request shape, and observable effect remained unchanged${attempts}, even after escalating recovery guidance.\n\n`
      + 'I parked this exact no-effect loop at its supervision boundary. Completed effects and diagnostics remain preserved. '
      + 'The turn remains active; provide new authenticated direction to resume, or cancel it.';
  }
  const reasons = detail.reason_codes?.length > 0
    ? ` The repeated operation reported: ${detail.reason_codes.join(', ')}.` : '';
  return `The active request stopped making verifiable progress.${reasons}\n\n`
    + 'I parked automatic recovery to avoid repeating the same unsuccessful work. Completed work and diagnostics remain preserved. '
    + 'Provide new direction to resume this turn, or cancel it.';
}

export function recoveryExhaustionDetail(recovery, transcript, reasonCodes, result) {
  return Object.freeze({
    ...recovery.exhaustion(transcript, reasonCodes),
    exhaustion_category: result.category ?? 'no_progress',
    exhaustion_count: result.count ?? null,
  });
}

function usefulAssistantCheckpoint(transcript, turnId) {
  if (!Array.isArray(transcript)) return null;
  const messages = transcript.filter((item) => item?.type === 'message'
    && item.role === 'assistant'
    && (!turnId || item.turnId === turnId)
    && typeof item.content === 'string'
    && item.content.trim().length > 0);
  if (messages.length === 0) return null;
  const recent = messages.slice(-5).reverse();
  const selected = recent.find((item) => item.content.trim().length >= MIN_USEFUL_CHECKPOINT_CHARACTERS) ?? recent[0];
  return boundedCheckpoint(selected.content.trim());
}

function boundedCheckpoint(content) {
  const limit = MAX_CHECKPOINT_CHARACTERS;
  if (content.length <= limit) return content;
  const head = content.slice(0, Math.floor(limit * CHECKPOINT_HEAD_RATIO)).trimEnd();
  const tail = content.slice(-(limit - head.length - CHECKPOINT_SEPARATOR_RESERVE)).trimStart();
  return `${head}\n...[checkpoint shortened]...\n${tail}`;
}

function effectCertainty(results) {
  const values = results.filter((item) => item?.type === 'tool_result')
    .map((item) => item.effect_certainty ?? item.effectCertainty).filter(Boolean);
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('partial')) return 'partial';
  if (values.includes('completed')) return 'completed';
  return 'none';
}

function evidenceValue(evidence) {
  return evidence && typeof evidence === 'object' && 'value' in evidence ? evidence.value : evidence;
}

function evidenceDetail(evidence, detail) {
  return evidence && typeof evidence === 'object' && 'detail' in evidence ? evidence.detail : detail;
}

function progressRecord(fingerprint, value, detail) {
  const kind = boundedLabel(detail.kind, 'model_evidence');
  return Object.freeze({
    fingerprint,
    kind,
    checkpoint: boundedLabel(detail.checkpoint, 'last_unique_result'),
    summary: Object.freeze(detail.summary ?? { evidence_bytes: Buffer.byteLength(String(value), 'utf8') }),
  });
}

function boundedLabel(value, fallback) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : fallback;
}

export function recoveryHint(action) {
  if (!action) return null;
  const guidance = {
    nudge: action.repeated_request_fingerprints?.length > 0
      ? 'The same tool request and result were repeated without observable progress. Do not submit the same arguments again; inspect the failure or choose a materially different bounded action.'
      : 'Previous work made no observable progress. Reassess the task and choose a materially different bounded action.',
    retry_continuation: 'Continue the active operator request using new evidence or a materially different action. Do not restart the conversation, greet the user again, ask what task to perform, or repeat an unchanged failed request.',
    compact: 'Context was reduced after repeated no-progress behavior. Preserve the operator task and use the last verified result.',
    reassess: 'Progress is still unclear. Inspect the latest committed evidence, recover the active objective from the recent authenticated conversation, and take one bounded next action.',
    change_strategy: 'The current approach has not demonstrated new progress. Keep the same objective, but change the hypothesis, tool, arguments, or verification method materially before continuing.',
    block_exact_request: 'This exact tool request reached its no-effect retry boundary and is unavailable until observable state changes. Do not pause the turn and do not submit it again. Continue the same objective with a different action, target, arguments, tool, or verification method; if the outcome is already established, report the remaining verification caveat and finish.',
    recover_objective: 'Re-anchor on the authenticated user intent and any explicitly adopted proposal. Preserve completed work, identify the smallest unfinished outcome, and continue with a new bounded action unless waiting for user input.',
    review_discovery_progress: 'Read-only discovery has continued for many tool batches. Compare the collected evidence with the unfinished outcome, state what material uncertainty remains, and either proceed or continue only with evidence that resolves that uncertainty.',
    review_work_convergence: 'The durable work revision has remained unchanged across several model steps. This is an orientation checkpoint, not a demand for plan ceremony. Compare the collected evidence with the current task outcome. Update work state only if status, evidence, or a blocker materially changed; otherwise take one bounded action that resolves the remaining uncertainty.',
    compact_context_limit: 'The provider rejected the previous context size. Continue from the preserved task using the reduced context; do not reconstruct omitted transcript.',
    retry_without_reasoning: 'The prior attempt produced hidden reasoning but no usable response. Continue the same task directly with reasoning disabled and produce visible text or a tool call.',
    retry_reasoning_to_action: 'The prior completion reached its output ceiling during reasoning before it could emit an action. Continue the same task with reasoning enabled, reason more concisely, and proceed to visible text or a tool call.',
    retry_provider_completion: `Provider recovery attempt ${action.count}: the prior response ended without recognized text, reasoning, or a tool call. Continue the same operator request and emit one visible response or one valid tool call. Do not repeat a content-free response.`,
  };
  return guidance[action.action] ?? null;
}

function terminalNoProgressLimit(category, localLimit, exactNoEffectLimit) {
  if (category === 'tool_no_progress') return exactNoEffectLimit;
  if (category === 'unfinished_conversation_work') {
    return Math.max(MIN_DURABLE_WORK_CONTINUATION_LIMIT, localLimit * 2);
  }
  if (BOUNDED_COMPLETION_CATEGORIES.has(category)) return localLimit;
  return null;
}

function recoveryAction(count, localLimit, ladder, allowCompaction) {
  const configured = ladder[count - 1];
  if (configured) return configured === 'compact' && allowCompaction === false ? 'nudge' : configured;
  if (count <= localLimit) return 'reassess';
  if (count <= localLimit * 2) return 'change_strategy';
  return 'recover_objective';
}

function boundedDelay(attempt) {
  return Math.min(1000, 50 * (2 ** attempt) + randomInt(0, 26));
}

function emptyCompletionDelay(count) {
  const exponent = Math.min(16, Math.max(0, count - 1));
  return Math.min(EMPTY_COMPLETION_MAX_DELAY_MS, EMPTY_COMPLETION_BASE_DELAY_MS * (2 ** exponent));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
