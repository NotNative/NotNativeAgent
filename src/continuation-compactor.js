// SPDX-License-Identifier: Apache-2.0
import { enrichCompactionFact } from './compaction.js';

const MAX_RESPONSE_BYTES = 65_536;

export class ContinuationCompactor {
  constructor(options = {}) {
    this.scheduler = options.scheduler;
    this.telemetry = options.telemetry;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async refine(fact, router, route, runtime, parentSignal) {
    const provider = router.provider(route);
    if (typeof provider.runtimeSnapshot !== 'function') return fact;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    parentSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, route.deadlineMs));
    let release = null;
    try {
      release = await this.scheduler.acquire(
        route.profile.id, `compaction:${fact.sourceFingerprint.slice(0, 16)}`,
        controller.signal, () => undefined, runtime?.parallelCapacity ?? null,
      );
      const text = await collect(provider.stream(compactionRequest(route, fact), controller.signal));
      const semantic = validateSemantic(parseJson(text));
      const enriched = enrichCompactionFact(fact, semantic);
      this.telemetry?.record('context.semantic_compaction', 'succeeded', {
        provider_profile: route.profile.id, model: route.model,
        source_fingerprint: fact.sourceFingerprint,
      });
      return enriched;
    } catch (error) {
      this.telemetry?.record('context.semantic_compaction', 'failed', {
        provider_profile: route.profile.id, model: route.model,
        source_fingerprint: fact.sourceFingerprint,
        failure: { code: error?.code ?? 'semantic_compaction_failed' },
      });
      return fact;
    } finally {
      release?.(); clearTimeout(timer);
      parentSignal?.removeEventListener('abort', cancel);
      controller.abort();
    }
  }
}

function compactionRequest(route, fact) {
  return Object.freeze({
    model: route.model, temperature: 0, maxOutputTokens: Math.min(route.maxOutputTokens, 2048), tools: [],
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
  const trimmed = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
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

function boundedArray(value) {
  if (!Array.isArray(value) || value.length > 16) throw codeError('semantic_compaction_invalid');
  if (value.some((item) => typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 8192)) {
    throw codeError('semantic_compaction_invalid');
  }
  return Object.freeze(value.map((item) => item.slice(0, 2048)));
}

function toCamel(value) { return value.replace(/_([a-z])/gu, (_, letter) => letter.toUpperCase()); }

function codeError(code) { const error = new Error(code); error.code = code; return error; }
