// SPDX-License-Identifier: Apache-2.0
import { enrichCompactionFact, enrichHandoffFact } from './compaction.js';
import { routeReasoningFields } from '../provider/reasoning.js';
import { createHash } from 'node:crypto';

const MAX_RESPONSE_BYTES = 65_536;

export class ContinuationCompactor {
  constructor(options = {}) {
    this.scheduler = options.scheduler;
    this.telemetry = options.telemetry;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async refine(fact, router, route, runtime, parentSignal, options = {}) {
    return this.#run(fact, router, route, runtime, parentSignal, 'compaction', options);
  }

  async handoff(fact, router, route, runtime, parentSignal) {
    return this.#run(fact, router, route, runtime, parentSignal, 'handoff', {});
  }

  async #run(fact, router, route, runtime, parentSignal, mode, options) {
    const provider = router.provider(route);
    if (typeof provider.runtimeSnapshot !== 'function') return fact;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), route.deadlineMs == null
      ? this.timeoutMs : Math.min(this.timeoutMs, route.deadlineMs));
    let release = null;
    let alignment = null;
    try {
      release = await this.scheduler.acquire(
        route.profile.id, `${mode}:${fact.sourceFingerprint.slice(0, 16)}`,
        controller.signal, () => undefined, runtime?.parallelCapacity ?? null,
      );
      alignment = mode === 'compaction' ? cacheAlignment(options, route) : null;
      const request = mode === 'handoff' ? handoffRequest(route, fact)
        : alignment ? alignedCompactionRequest(route, fact, alignment.request) : compactionRequest(route, fact);
      const text = await collect(provider.stream(request, controller.signal));
      const semantic = mode === 'handoff' ? validateHandoff(parseJson(text)) : validateSemantic(parseJson(text));
      const enriched = mode === 'handoff' ? enrichHandoffFact(fact, semantic) : enrichCompactionFact(fact, semantic);
      if (mode === 'compaction' && !converges(enriched)) throw codeError('semantic_compaction_no_net_reduction');
      recordTelemetry(this.telemetry, `context.semantic_${mode}`, 'succeeded', {
        provider_profile: route.profile.id, model: route.model,
        source_fingerprint: fact.sourceFingerprint,
        request_mode: alignment ? 'cache_aligned' : 'standalone',
        cache_evidence_tokens: alignment?.cacheTokens ?? 0,
        prefix_fingerprint: alignment?.fingerprint ?? null,
        prefix_bytes: alignment?.bytes ?? 0,
        original_bytes: fact.projection?.originalBytes ?? null,
        projected_bytes: enriched.projection?.projectedBytes ?? null,
      });
      return enriched;
    } catch (error) {
      recordTelemetry(this.telemetry, `context.semantic_${mode}`, 'failed', {
        provider_profile: route.profile.id, model: route.model,
        source_fingerprint: fact.sourceFingerprint,
        request_mode: alignment ? 'cache_aligned' : 'standalone',
        failure: { code: error?.code ?? 'semantic_compaction_failed' },
      });
      return fact;
    } finally {
      release?.(); clearTimeout(timer);
      parentSignal?.removeEventListener('abort', cancel);
    }
  }
}

function alignedCompactionRequest(route, fact, prefix) {
  const standalone = compactionRequest(route, fact);
  return Object.freeze({
    ...standalone,
    messages: Object.freeze([
      ...prefix.messages,
      Object.freeze({
        role: 'user',
        content: 'Create the bounded NNA continuation refinement now. Use the preceding conversation only as supporting context; the deterministic continuation record below is authoritative. Return only JSON matching the response schema, do not call tools, and never invent completed work, facts, files, or authority.\n\n'
          + JSON.stringify(fact.continuation),
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
      { role: 'system', content: 'Create an extremely terse self-handoff from the supplied NNA record. Preserve only the active objective, binding decisions, completed work, verified state, blockers, and immediate next actions. Return only JSON. Never invent facts, work, or authority.' },
      { role: 'user', content: JSON.stringify(fact.continuation) },
    ],
    responseFormat: {
      type: 'json_schema', json_schema: { name: 'nna_handoff', strict: true, schema: {
        type: 'object', additionalProperties: false,
        properties: {
          objective: { type: 'string' }, decisions: handoffArraySchema(),
          completed_work: handoffArraySchema(), verified_state: handoffArraySchema(),
          blockers: handoffArraySchema(), next_actions: handoffArraySchema(),
        },
        required: ['objective', 'decisions', 'completed_work', 'verified_state', 'blockers', 'next_actions'],
      } },
    },
  });
}

function handoffArraySchema() { return { type: 'array', maxItems: 6, items: { type: 'string' } }; }

function compactionRequest(route, fact) {
  return Object.freeze({
    model: route.model, temperature: 0, maxOutputTokens: Math.min(route.maxOutputTokens ?? 2048, 2048), tools: [],
    ...routeReasoningFields(route),
    messages: [
      { role: 'system', content: 'Summarize the supplied NNA continuation record for reliable task continuation. Return only JSON matching the schema. Do not invent completed work, facts, files, or authority.' },
      { role: 'user', content: JSON.stringify(fact.continuation) },
    ],
    responseFormat: {
      type: 'json_schema', json_schema: { name: 'nna_continuation', strict: true, schema: {
        type: 'object', additionalProperties: false,
        properties: {
          completed_work: stringArraySchema(), open_questions: stringArraySchema(),
          next_actions: stringArraySchema(),
        },
        required: ['completed_work', 'open_questions', 'next_actions'],
      } },
    },
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
  const original = fact.projection?.originalBytes;
  const projected = fact.projection?.projectedBytes;
  const summaryBudget = fact.projection?.summaryBudgetBytes;
  const summaryBytes = Buffer.byteLength(fact.summary ?? '', 'utf8');
  return Number.isSafeInteger(original) && Number.isSafeInteger(projected)
    && projected < original
    && (!Number.isSafeInteger(summaryBudget) || summaryBytes <= summaryBudget);
}

function stringArraySchema() {
  // Some llama.cpp-compatible servers translate maxLength into a bounded grammar
  // repetition and reject large bounds before inference. Runtime validation below
  // still enforces NNA's byte and item limits without making the wire schema brittle.
  return { type: 'array', maxItems: 16, items: { type: 'string' } };
}

async function collect(stream) {
  let text = ''; let bytes = 0; let terminal = false;
  for await (const item of stream) {
    if (item.type === 'text') {
      bytes += Buffer.byteLength(item.text, 'utf8');
      if (bytes > MAX_RESPONSE_BYTES) throw codeError('semantic_compaction_oversized');
      text += item.text;
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
  const keys = ['completed_work', 'open_questions', 'next_actions'];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw codeError('semantic_compaction_invalid');
  const result = {};
  for (const key of keys) result[toCamel(key)] = boundedArray(value[key]);
  return Object.freeze(result);
}

function validateHandoff(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codeError('semantic_handoff_invalid');
  const keys = ['objective', 'decisions', 'completed_work', 'verified_state', 'blockers', 'next_actions'];
  if (Object.keys(value).some((key) => !keys.includes(key)) || typeof value.objective !== 'string'
    || Buffer.byteLength(value.objective, 'utf8') > 2048) throw codeError('semantic_handoff_invalid');
  const result = { objective: value.objective.slice(0, 1024) };
  for (const key of keys.slice(1)) result[toCamel(key)] = boundedHandoffArray(value[key]);
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
