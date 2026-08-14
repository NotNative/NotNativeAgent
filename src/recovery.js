// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { randomInt } from 'node:crypto';

export class RecoverySupervisor {
  #episodes = new Map();
  #progress = new Map();
  #actions = [];

  constructor(options = {}) {
    this.localLimit = options.localLimit ?? 3;
    this.ladder = options.ladder ?? ['nudge', 'compact'];
    this.#actions = (options.restoredActions ?? []).slice(-256);
  }

  providerRetry(category, attempt, partial) {
    if (partial || attempt >= this.localLimit - 1) return Object.freeze({ retry: false, exhausted: true });
    const delayMs = boundedDelay(attempt);
    const action = this.#record(category, 'retry_provider', attempt + 1, {
      delayMs, target: 'current_route', partial: false,
    });
    return Object.freeze({ retry: true, delayMs, action });
  }

  contextLimit(partial, scale = 0.5) {
    const category = 'provider_context_limit';
    const count = this.#episodes.get(category) ?? 0;
    if (partial || count >= 1) return Object.freeze({ continue: false, exhausted: true });
    this.#episodes.set(category, count + 1);
    const action = this.#record(category, 'compact_context_limit', count + 1, {
      target: 'current_route', partial: false, scale,
    });
    return Object.freeze({ continue: true, scale, action });
  }

  reasoningOnly() {
    return this.#record('reasoning_only_output', 'retry_without_reasoning', 1, {
      target: 'current_route', partial: false,
    });
  }

  noProgress(category, evidence = null, detail = {}, options = {}) {
    const observedDetail = evidenceDetail(evidence, detail);
    if (evidence && this.observeProgress(evidenceValue(evidence), observedDetail)) {
      this.#clearEpisodes(category);
      return Object.freeze({ continue: true, progress: true, action: null });
    }
    const episode = episodeKey(category, options.failureFingerprint);
    const count = (this.#episodes.get(episode) ?? 0) + 1;
    this.#episodes.set(episode, count);
    if (count >= this.localLimit) return Object.freeze({ continue: false, exhausted: true, count });
    const configuredAction = this.ladder[count - 1];
    const action = configuredAction === 'compact' && options.allowCompaction === false ? 'nudge' : configuredAction;
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
    if (this.#progress.size >= 4096) this.#progress.delete(this.#progress.keys().next().value);
    this.#progress.set(fingerprint, progressRecord(fingerprint, value, detail));
    return true;
  }

  externalEvidence(value) {
    this.observeProgress(`external:${value}`);
    this.#episodes.clear();
  }

  exhaustion(toolResults = [], reasonCodes = []) {
    const evidence = [...this.#progress.values()].slice(-32);
    const checkpoint = evidence.at(-1)?.checkpoint ?? 'turn_start';
    return Object.freeze({
      code: 'recovery_exhausted', retryable: true, partial: evidence.length > 0,
      progress_fingerprints: this.#progress.size,
      completed_progress: Object.freeze({
        unique_evidence_count: this.#progress.size,
        fingerprints: Object.freeze(evidence.map((item) => item.fingerprint)),
        evidence: Object.freeze(evidence),
      }),
      recovery_actions: Object.freeze(this.#actions.slice(-32)),
      last_checkpoint: checkpoint,
      last_verified_checkpoint: checkpoint,
      remaining_work: 'model continuation did not demonstrate forward progress',
      resume_condition: 'new authenticated input or changed external evidence',
      reason_codes: Object.freeze([...new Set(reasonCodes.filter(Boolean))].slice(0, 16)),
      side_effect_certainty: effectCertainty(toolResults),
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
    if (this.#actions.length > 256) this.#actions.shift();
    return record;
  }

  #clearEpisodes(category) {
    for (const key of this.#episodes.keys()) {
      if (key === category || key.startsWith(`${category}\0`)) this.#episodes.delete(key);
    }
  }
}

function episodeKey(category, failureFingerprint) {
  return failureFingerprint ? `${category}\0${failureFingerprint}` : category;
}

function repeatedEvidenceDetail(detail) {
  const fingerprints = detail?.summary?.request_fingerprints;
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) return {};
  return { repeated_request_fingerprints: Object.freeze(fingerprints.slice(0, 16)) };
}

export function recoveryExhaustionText(detail, options = {}) {
  if (detail.exhaustion_category === 'empty_output') {
    const checkpoint = usefulAssistantCheckpoint(options.transcript, options.turnId);
    const attempts = Number.isInteger(detail.exhaustion_count) ? ` after ${detail.exhaustion_count} attempts` : '';
    const preserved = checkpoint
      ? `\n\nLast useful assistant checkpoint:\n${checkpoint}`
      : '';
    return `The model returned no usable continuation${attempts}, so I stopped retrying. `
      + `Completed tool effects and diagnostics remain preserved.${preserved}\n\n`
      + 'The remaining step was not completed. Resume from the activity details or provide new direction.';
  }
  const reasons = detail.reason_codes?.length > 0
    ? ` The repeated operation reported: ${detail.reason_codes.join(', ')}.` : '';
  return `I couldn't complete the request because the turn stopped making verifiable progress.${reasons}\n\n`
    + 'I ended the turn to avoid repeating the same unsuccessful work. Any completed work and diagnostics remain preserved. '
    + 'You can retry after correcting the reported condition or provide new direction.';
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
  const selected = recent.find((item) => item.content.trim().length >= 160) ?? recent[0];
  return boundedCheckpoint(selected.content.trim());
}

function boundedCheckpoint(content) {
  const limit = 2400;
  if (content.length <= limit) return content;
  const head = content.slice(0, Math.floor(limit * 0.7)).trimEnd();
  const tail = content.slice(-(limit - head.length - 32)).trimStart();
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
    compact_context_limit: 'The provider rejected the previous context size. Continue from the preserved task using the reduced context; do not reconstruct omitted transcript.',
    retry_without_reasoning: 'The prior attempt produced hidden reasoning but no usable response. Continue the same task directly with reasoning disabled and produce visible text or a tool call.',
  };
  return guidance[action.action] ?? null;
}

function boundedDelay(attempt) {
  return Math.min(1000, 50 * (2 ** attempt) + randomInt(0, 26));
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
