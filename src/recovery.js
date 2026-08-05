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

  noProgress(category, evidence = null, detail = {}) {
    if (evidence && this.observeProgress(evidenceValue(evidence), evidenceDetail(evidence, detail))) {
      this.#episodes.delete(category);
      return Object.freeze({ continue: true, progress: true, action: null });
    }
    const count = (this.#episodes.get(category) ?? 0) + 1;
    this.#episodes.set(category, count);
    if (count >= this.localLimit) return Object.freeze({ continue: false, exhausted: true, count });
    return Object.freeze({
      continue: true, progress: false, count,
      action: this.#record(category, this.ladder[count - 1], count),
    });
  }

  continuation(category, evidence = null, detail = {}) {
    const plan = this.noProgress(category, evidence, detail);
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
}

export function recoveryExhaustionText(detail) {
  const reasons = detail.reason_codes?.length > 0
    ? ` The repeated operation reported: ${detail.reason_codes.join(', ')}.` : '';
  return `I couldn't complete the request because the turn stopped making verifiable progress.${reasons}\n\n`
    + 'I ended the turn to avoid repeating the same unsuccessful work. Any completed work and diagnostics remain preserved. '
    + 'You can retry after correcting the reported condition or provide new direction.';
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
    nudge: 'Previous work made no observable progress. Reassess the task and choose a materially different bounded action.',
    retry_continuation: 'Continue the active operator request using new evidence or a materially different action. Do not restart the conversation, greet the user again, ask what task to perform, or repeat an unchanged failed request.',
    compact: 'Context was reduced after repeated no-progress behavior. Preserve the operator task and use the last verified result.',
    compact_context_limit: 'The provider rejected the previous context size. Continue from the preserved task using the reduced context; do not reconstruct omitted transcript.',
  };
  return guidance[action.action] ?? null;
}

function boundedDelay(attempt) {
  return Math.min(1000, 50 * (2 ** attempt) + randomInt(0, 26));
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
