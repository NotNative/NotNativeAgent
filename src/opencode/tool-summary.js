// SPDX-License-Identifier: Apache-2.0
/**
 * What a tool row shows a reader, without echoing what the tool read.
 *
 * Why this exists: every row in the transcript said only the tool's name, so a
 * turn's worth of work read as `Fs read`, `Fs read`, `Fs read` with "No output
 * produced" under each. The information a reader wants is what was touched and how
 * it went, and the engine already computes that for its own journal.
 *
 * Security: this publishes *derived* facts — a safe target, a status, an exit code,
 * a duration, a count. It never publishes a tool's arguments or its result text.
 * Those can carry a credential or retrieved page content, and a transcript is fed
 * back to the model on the next turn, so echoing them there would let retrieval
 * gain authority it was never granted. See `toolDisplay` for the one field that
 * carries output, and why it is marked display-only.
 */

import { redactText } from '../redaction.js';

/** Targets are already bounded by the journal; the row has less room than a record. */
const MAX_TARGET_LENGTH = 160;
/** Display-only output cap. Enough to see what a call printed; not a transcript. */
const MAX_OUTPUT_LENGTH = 4_096;

/**
 * The output a reader may expand a row to see.
 *
 * Security: this is display-only by construction. The wire transcript is a display
 * surface; the model's context is built from the engine journal (`buildPromptCommand`),
 * which never reads these parts. The text passes `redactText` — the same credential
 * scrubbing the journal applies — so a secret that appeared in a command's output
 * does not reach the operator's screen or a client's persisted session copy either.
 * A client may show it on request; nothing feeds it back to a model.
 *
 * @param {unknown} content the tool's result content, as the engine recorded it
 * @returns {string|null} redacted, single-spaced, capped text
 */
export function toolDisplayOutput(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const redacted = redactText(content).replace(/\s+/gu, ' ').trim();
  if (!redacted) return null;
  return redacted.length > MAX_OUTPUT_LENGTH ? `${redacted.slice(0, MAX_OUTPUT_LENGTH - 1)}…` : redacted;
}

/**
 * The one-line summary shown beside a tool's name.
 *
 * @param {{target?: string|null, status?: string|null, exitCode?: number|null,
 *          elapsedMs?: number|null, observationOutcome?: string|null}} record
 * @returns {{ target: string|null, outcome: string|null }}
 */
export function toolSummary(record) {
  return {
    target: boundedTarget(record?.target),
    outcome: outcomeText(record),
  };
}

function boundedTarget(target) {
  if (typeof target !== 'string') return null;
  const trimmed = target.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TARGET_LENGTH ? `${trimmed.slice(0, MAX_TARGET_LENGTH - 1)}…` : trimmed;
}

/** What happened, as a short phrase. Absent rather than guessed when unknown. */
function outcomeText(record) {
  const status = typeof record?.status === 'string' ? record.status : null;
  if (!status) return null;
  if (status === 'succeeded') {
    const parts = [];
    if (Number.isSafeInteger(record?.exitCode) && record.exitCode !== 0) parts.push(`exit ${record.exitCode}`);
    if (Number.isFinite(record?.elapsedMs)) parts.push(`${formatDuration(record.elapsedMs)}`);
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  if (status === 'completed_nonzero') {
    return Number.isSafeInteger(record?.exitCode) ? `exit ${record.exitCode}` : 'non-zero exit';
  }
  if (RUNNING.has(status)) return null;
  // A failure names its reason, which the engine already bounded for the journal.
  const reason = typeof record?.failureReason === 'string' ? record.failureReason.trim() : '';
  return reason ? reason.slice(0, MAX_TARGET_LENGTH) : 'did not complete';
}

const RUNNING = new Set(['review_pending', 'approved', 'running']);

/**
 * The tool part state a transcript row renders, from one engine status record.
 *
 * Why the summary lives in `input`: a client labels the row from the call's input
 * and metadata, so an empty input is what rendered a turn as a column of bare tool
 * names with "No output produced" under each. `target` is the journal's already
 * redacted description of what was touched — a path or a command — never the
 * arguments themselves.
 *
 * Why output under `metadata.output`: the v2 tool-state schema is closed at the top
 * level, and a client's expandable row reads `metadata.output` as its fallback
 * source. Display-only: the engine redacts and caps the excerpt at the source, and
 * the model's context never reads it.
 *
 * @param {Record<string, unknown>} record one engine `tool_status` record
 * @param {'completed'|'error'|'running'} terminal the wire status
 */
export function toolPartState(record, terminal) {
  const summary = toolSummary({
    target: record.target, status: record.status, exitCode: record.exit_code,
    elapsedMs: record.elapsed_ms, observationOutcome: record.observation_outcome,
    failureReason: record.failure_reason,
  });
  const input = summary.target ? { target: summary.target } : {};
  const output = toolDisplayOutput(record.display_content);
  const metadata = { ...(summary.outcome ? { outcome: summary.outcome } : {}), ...(output ? { output } : {}) };
  if (terminal === 'completed') {
    return { status: 'completed', input, metadata, content: [{ type: 'text', text: summary.outcome ?? '' }] };
  }
  if (terminal === 'error') {
    return { status: 'error', input, metadata, error: { type: 'nna_tool_failed',
      message: 'The tool did not complete. NNA records the reason in its own journal.' } };
  }
  return { status: 'running', input, metadata };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}
