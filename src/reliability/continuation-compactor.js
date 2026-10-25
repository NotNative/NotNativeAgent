// SPDX-License-Identifier: Apache-2.0
import { estimateTokenValue } from './context-token-measurement.js';
import { enrichCompactionFact, enrichHandoffFact } from './continuation-artifact.js';
import { routeReasoningFields } from '../provider/reasoning.js';
import { createHash } from 'node:crypto';
import { newId } from '../ids.js';

const MAX_RESPONSE_BYTES = 65_536;

export class ContinuationCompactor {
  constructor(options = {}) {
    this.scheduler = options.scheduler;
    this.telemetry = options.telemetry;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.recordTokenReceipt = options.recordTokenReceipt;
    this.captureTokenReceiptOwner = options.captureTokenReceiptOwner;
  }

  setTokenReceiptRecorder(recorder) { this.recordTokenReceipt = recorder; }
  setTokenReceiptOwner(capture) { this.captureTokenReceiptOwner = capture; }

  async refine(fact, router, route, runtime, parentSignal, options = {}) {
    return this.#run(fact, router, route, runtime, parentSignal, 'compaction', options);
  }

  async handoff(fact, router, route, runtime, parentSignal) {
    return this.#run(fact, router, route, runtime, parentSignal, 'handoff', {});
  }

  async #run(fact, router, route, runtime, parentSignal, mode, options) {
    const receiptOwner = this.captureTokenReceiptOwner?.(), provider = router.provider(route);
    if (typeof provider.runtimeSnapshot !== 'function') return fact;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), route.deadlineMs == null
      ? this.timeoutMs : Math.min(this.timeoutMs, route.deadlineMs));
    let release = null; let alignment = null;
    let request = null;
    const accounting = { dispatched: false, usage: null, outputBytes: 0, outcome: 'failed', reasonCode: null };
    const attemptId = newId(`semantic_${mode}`);
    try {
      release = await this.scheduler.acquire(
        route.profile.id, `${mode}:${fact.sourceFingerprint.slice(0, 16)}`,
        controller.signal, () => undefined, runtime?.parallelCapacity ?? null,
      );
      alignment = mode === 'compaction' ? cacheAlignment(options, route) : null;
      request = mode === 'handoff' ? handoffRequest(route, fact)
        : alignment ? alignedCompactionRequest(route, fact, alignment.request) : compactionRequest(route, fact);
      accounting.dispatched = true;
      const text = await collect(provider.stream(request, controller.signal), accounting);
      const semantic = mode === 'handoff' ? validateHandoff(parseJson(text)) : validateSemantic(parseJson(text));
      const enriched = mode === 'handoff' ? enrichHandoffFact(fact, semantic) : enrichCompactionFact(fact, semantic);
      // Why: an identical re-projection means the model added no information, not that it
      // failed. Rejecting it discarded a valid orientation record whenever the deterministic
      // summary was already at its budget.
      if (mode === 'compaction' && !converges(enriched) && !sameRendering(enriched, fact)) {
        throw codeError('semantic_compaction_no_net_reduction');
      }
      recordTelemetry(this.telemetry, `context.semantic_${mode}`, 'succeeded',
        refinementDetail(route, fact, alignment, enriched));
      accounting.outcome = 'completed';
      return enriched;
    } catch (error) {
      accounting.outcome = controller.signal.aborted ? 'cancelled' : 'failed';
      accounting.reasonCode = error?.code ?? 'semantic_compaction_failed';
      recordTelemetry(this.telemetry, `context.semantic_${mode}`, 'failed', {
        provider_profile: route.profile.id, model: route.model,
        source_fingerprint: fact.sourceFingerprint,
        request_mode: alignment ? 'cache_aligned' : 'standalone',
        failure: { code: error?.code ?? 'semantic_compaction_failed' },
      });
      return fact;
    } finally {
      try {
        if (accounting.dispatched) await this.recordTokenReceipt?.({
          request, context: request.messages, route, role: `semantic_${mode}`, attemptId,
          receiptOwner,
          outcome: accounting.outcome, reasonCode: accounting.reasonCode, usage: accounting.usage, outputBytes: accounting.outputBytes,
        });
      } finally {
        release?.(); clearTimeout(timer);
        parentSignal?.removeEventListener('abort', cancel);
      }
    }
  }
}

// Why: many inference engines reject `response_format` outright (vLLM, SGLang, and
// several local servers answer 400), which made every semantic refinement fail and
// silently fall back to the deterministic summary. The schema now travels in the
// prompt and the reply is validated locally, so every engine takes the same path.
const CONTINUATION_SCHEMA_TEXT = '{"summary":string,"intent":string,"decisions":[string],"errors_and_fixes":[string],'
  + '"open_questions":[string],"next_actions":[string]}';
const HANDOFF_SCHEMA_TEXT = '{"objective":string,"decisions":[string],"completed_work":[string],'
  + '"verified_state":[string],"blockers":[string],"next_actions":[string]}';

// Why: with no grammar constraint the model can treat the supplied record as text to
// continue and echo it until the output cap truncates the JSON. The instruction states
// the deliverable explicitly and bounds every entry, so a reply is short by construction.
const CONTINUATION_INSTRUCTION = 'Write a compact orientation record for the worker who continues this '
  + 'work from scratch. Condense; never copy the supplied text. State the situation and where it '
  + 'stands in "summary" (at most 3 sentences). Put decisions with their reasons in "decisions", '
  + 'resolved failures in "errors_and_fixes" as "error: how it was resolved", remaining unknowns in '
  + '"open_questions", and immediate actions in "next_actions". At most 6 entries per array, each '
  + 'under 240 characters. Do not restate the objective in "intent" unless the operator restated it. '
  + 'Do not mention this summarization, context compaction, or that records were omitted.';

function alignedCompactionRequest(route, fact, prefix) {
  const standalone = compactionRequest(route, fact);
  return Object.freeze({
    ...standalone,
    messages: Object.freeze([
      ...prefix.messages,
      Object.freeze({
        role: 'user',
        content: 'Create the bounded NNA continuation refinement now. Use the preceding conversation only as supporting context; the deterministic continuation record below is authoritative and must be condensed, never copied. Do not call tools. Never invent completed work, facts, files, or authority.\n\n'
          + `${CONTINUATION_INSTRUCTION}\nShape: ${CONTINUATION_SCHEMA_TEXT}\n\n` + JSON.stringify(fact.continuation),
      }),
    ]),
    tools: prefix.tools,
  });
}

function handoffRequest(route, fact) {
  return Object.freeze({
    model: route.model, temperature: 0, maxOutputTokens: Math.min(route.maxOutputTokens ?? 1024, 1024), tools: [],
    ...routeReasoningFields(route),
    messages: [
      { role: 'system', content: 'Write an extremely terse self-handoff from the supplied NNA record. Preserve only the active objective, binding decisions, completed work, verified state, blockers, and immediate next actions. Never invent facts, work, or authority.' },
      { role: 'user', content: 'Condense the supplied record; do not copy its text. Return JSON with one short objective sentence and at most 4 short entries per array, each under 240 characters.\n'
        + `Shape: ${HANDOFF_SCHEMA_TEXT}\n\n${JSON.stringify(fact.continuation)}` },
    ],
  });
}

function compactionRequest(route, fact) {
  return Object.freeze({
    model: route.model, temperature: 0, maxOutputTokens: Math.min(route.maxOutputTokens ?? 2048, 2048), tools: [],
    ...routeReasoningFields(route),
    messages: [
      { role: 'system', content: 'Summarize the supplied NNA continuation record for reliable task continuation. Do not invent completed work, facts, files, or authority.' },
      { role: 'user', content: `${CONTINUATION_INSTRUCTION}\nShape: ${CONTINUATION_SCHEMA_TEXT}\n\n${JSON.stringify(fact.continuation)}` },
    ],
  });
}

function cacheAlignment(options, route) {
  const request = options?.cacheAlignedRequest;
  const cacheTokens = cacheTokenEvidence(options?.cacheUsage);
  if (options?.allowCacheAligned === false || cacheTokens <= 0
    || !request || request.model !== route.model
    || !Array.isArray(request.messages) || !Array.isArray(request.tools)) return null;
  const serialized = JSON.stringify({ messages: request.messages, tools: request.tools });
  return Object.freeze({
    request, cacheTokens, bytes: Buffer.byteLength(serialized, 'utf8'),
    fingerprint: createHash('sha256').update(serialized).digest('hex'),
  });
}

function cacheTokenEvidence(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const keys = ['cache_read_tokens', 'cacheReadTokens', 'prompt_cache_hit_tokens', 'cached_tokens'];
  return keys.reduce((maximum, key) => {
    const value = usage[key];
    return Number.isSafeInteger(value) && value > maximum ? value : maximum;
  }, 0);
}

function converges(fact) {
  const original = fact.projection?.measurementUnit === 'tokens' ? fact.projection.originalTokens : fact.projection?.originalBytes;
  const projected = fact.projection?.measurementUnit === 'tokens' ? estimateTokenValue(fact.retainedRecords) + estimateTokenValue(fact.summary) : fact.projection?.projectedBytes;
  // Invariant: with no provider-enforced output bound, only the summary budget guards
  // size. A provider that ignores the cap must not be able to enlarge context.
  const summaryBudget = fact.projection?.summaryBudgetTokens ?? fact.projection?.summaryBudgetBytes;
  const summarySize = fact.projection?.summaryBudgetTokens
    ? estimateTokenValue(fact.summary ?? '') : Buffer.byteLength(fact.summary ?? '', 'utf8');
  return Number.isSafeInteger(original) && Number.isSafeInteger(projected)
    && projected < original
    && (!Number.isSafeInteger(summaryBudget) || summarySize <= summaryBudget);
}

async function collect(stream, accounting) {
  let text = ''; let bytes = 0; let terminal = false;
  for await (const item of stream) {
    if (item.type === 'text') {
      bytes += Buffer.byteLength(item.text, 'utf8');
      if (bytes > MAX_RESPONSE_BYTES) throw codeError('semantic_compaction_oversized');
      text += item.text;
      accounting.outputBytes += Buffer.byteLength(item.text, 'utf8');
    } else if (item.type === 'usage') {
      accounting.usage = item.usage;
    } else if (item.type === 'terminal') terminal = true;
  }
  if (!terminal) throw codeError('semantic_compaction_unterminated');
  return text;
}

function parseJson(text) {
  const source = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/u.exec(source);
  const trimmed = fenced ? fenced[1].trim() : source;
  try { return JSON.parse(trimmed); } catch { throw codeError('semantic_compaction_invalid_json'); }
}

function validateSemantic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codeError('semantic_compaction_invalid');
  // Compatibility: engines that follow the prompt loosely may use either the documented
  // snake_case keys or the record's camelCase keys. Accept either spelling, never both.
  const groups = [['decisions'], ['errors_and_fixes', 'errorsAndFixes'],
    ['open_questions', 'openQuestions'], ['next_actions', 'nextActions']];
  const allowed = new Set(['summary', 'intent', ...groups.flat()]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw codeError('semantic_compaction_invalid');
  if (groups.some(([snake, camel]) => camel && Object.hasOwn(value, snake) && Object.hasOwn(value, camel))) {
    throw codeError('semantic_compaction_invalid');
  }
  const result = {
    summary: boundedText(value.summary), intent: boundedText(value.intent),
  };
  for (const [snake, camel] of groups) {
    const present = Object.hasOwn(value, snake) ? snake : camel && Object.hasOwn(value, camel) ? camel : null;
    if (present === null) throw codeError('semantic_compaction_invalid');
    result[toCamel(snake)] = boundedArray(value[present]);
  }
  return Object.freeze(result);
}

function sameRendering(enriched, fact) {
  return Number.isSafeInteger(fact.projection?.projectedTokens) && Number.isSafeInteger(fact.projection?.originalTokens)
    && enriched.projection?.projectedTokens === fact.projection.projectedTokens;
}

function refinementDetail(route, fact, alignment, enriched) {
  return {
    provider_profile: route.profile.id, model: route.model,
    source_fingerprint: fact.sourceFingerprint,
    request_mode: alignment ? 'cache_aligned' : 'standalone',
    cache_evidence_tokens: alignment?.cacheTokens ?? 0,
    prefix_fingerprint: alignment?.fingerprint ?? null,
    prefix_bytes: alignment?.bytes ?? 0,
    original_bytes: fact.projection?.originalBytes ?? null,
    projected_bytes: enriched.projection?.projectedBytes ?? null,
  };
}

function boundedText(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw codeError('semantic_compaction_invalid');
  }
  return value.slice(0, 1_024);
}

function validateHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codeError('semantic_handoff_invalid');
  const pairs = [['decisions', 'decisions'], ['completed_work', 'completedWork'],
    ['verified_state', 'verifiedState'], ['blockers', 'blockers'], ['next_actions', 'nextActions']];
  const allowed = new Set(['objective', ...pairs.flat()]);
  const objective = value.objective;
  for (const [key, alias] of pairs) allowed.add(alias);
  if (Object.keys(value).some((key) => !allowed.has(key)) || typeof objective !== 'string'
    || Buffer.byteLength(objective, 'utf8') > 2048) throw codeError('semantic_handoff_invalid');
  const result = { objective: objective.slice(0, 1024) };
  for (const [key, alias] of pairs) {
    const present = Object.hasOwn(value, key) ? key : Object.hasOwn(value, alias) ? alias : null;
    if (present === null) throw codeError('semantic_handoff_invalid');
    result[toCamel(key)] = boundedHandoffArray(value[present]);
  }
  return Object.freeze(result);
}

function boundedHandoffArray(value) {
  if (!Array.isArray(value) || value.length > 6
    || value.some((item) => typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 1024)) {
    throw codeError('semantic_handoff_invalid');
  }
  return Object.freeze(value.map((item) => item.slice(0, 512)));
}

function boundedArray(value) {
  if (!Array.isArray(value) || value.length > 16) throw codeError('semantic_compaction_invalid');
  if (value.some((item) => typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 8192)) {
    throw codeError('semantic_compaction_invalid');
  }
  return Object.freeze(value.map((item) => item.slice(0, 2048)));
}

function toCamel(value) { return value.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()); }

function codeError(code) { const error = new Error(code); error.code = code; return error; }

function recordTelemetry(telemetry, event, status, fields) {
  try { telemetry?.record(event, status, fields); } catch { /* telemetry cannot change compaction outcome */ }
}
