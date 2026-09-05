// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { providerReasoningControls } from './provider/reasoning.js';
import { providerRetryAfterMs } from './reliability/retry-after.js';
import { localProviderFetch } from './provider/local-http-transport.js';
import { CredentialResolver, normalizeCredentialBinding } from './credential-bindings.js';
import { sanitizeProviderUsage, unrecognizedDeltaEvent } from './provider/event-shape.js';
import { providerModelLimits } from './provider/model-metadata.js';
import { chatCompletionBody, toolCallProbeRequest } from './provider/tool-call-compatibility.js';
const MIN_PROVIDER_STREAM_BYTES = 2_097_152;
const UNDECLARED_PROVIDER_STREAM_BYTES = 67_108_864;
const MAX_PROVIDER_STREAM_BYTES = 268_435_456;
const PROVIDER_STREAM_BYTES_PER_OUTPUT_TOKEN = 1_024;
export class OpenAICompatibleProvider {
  constructor(profile, limits = {}, options = {}) {
    this.profile = profile;
    this.limits = limits;
    this.fetch = options.fetch ?? (profile.trustZone === 'public_network' ? globalThis.fetch : localProviderFetch);
    this.credentialResolver = options.credentialResolver ?? new CredentialResolver();
    this.sessionId = options.sessionId;
    this.credential = normalizeCredentialBinding(profile.credential, profile.credentialEnv);
  }

  async capabilities(signal) {
    const response = await this.#fetch(`${this.profile.endpoint}/models`, { signal }, 'Discover provider models');
    if (!response.ok) throw providerError(response.status, 'model enumeration failed');
    const body = await boundedResponseJson(response);
    const entries = Array.isArray(body.data) ? body.data : [];
    const boundedEntries = entries.slice(0, 4096);
    const models = boundedEntries.map((item) => item?.id)
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256);
    const selected = boundedEntries.find((item) => modelIdentityMatches(this.profile.model, item?.id));
    const reported = providerModelLimits(selected);
    return Object.freeze({
      ...this.profile.capabilities,
      model: this.profile.model,
      models: Object.freeze(models.slice(0, 4096)),
      contextLimitBytes: knownPositiveInteger(selected?.context_limit_bytes) ?? this.profile.contextLimitBytes ?? 'unknown',
      contextLimitTokens: reported.contextWindowTokens ?? 'unknown',
      outputLimitTokens: reported.outputLimitTokens ?? this.profile.outputLimitTokens ?? 'unknown',
    });
  }

  async runtimeSnapshot(signal) {
    const declared = declaredRuntime(this.profile);
    if (this.profile.trustZone === 'public_network') {
      return runtimeFromCapabilities(await this.capabilities(signal), declared, 'openai_models');
    }
    const root = this.profile.endpoint.replace(/\/+v1\/?$/u, '');
    for (const [path, parser] of [['/api/v1/models', parseLmStudioV1], ['/api/v0/models', parseLmStudioV0]]) {
      try {
        const response = await this.#fetch(`${root}${path}`, { signal }, 'Discover provider runtime limits');
        if (!response.ok) continue;
        const snapshot = parser(await boundedResponseJson(response), this.profile.model, declared);
        if (snapshot) return snapshot;
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return runtimeFromCapabilities(await this.capabilities(signal), declared, 'openai_models');
  }

  async health(signal) {
    try {
      const response = await this.#fetch(`${this.profile.endpoint}/models`, { signal }, 'Check provider health');
      if (!response.ok) throw providerError(response.status, 'provider health probe failed');
      await response.body?.cancel();
      return true;
    } catch (error) {
      throw normalizeProviderTransportError(error, signal);
    }
  }

  async toolCallCompatibility(signal) {
    const single = await this.#toolCallProbe(false, signal);
    if (single.accepted) return Object.freeze({ supportedMode: 'single' });
    if (single.status !== 400) throw single.error;
    const batch = await this.#toolCallProbe(undefined, signal);
    if (!batch.accepted) throw batch.error;
    return Object.freeze({ supportedMode: 'batch' });
  }

  async *stream(request, signal) {
    const transport = new AbortController();
    const cancel = () => transport.abort();
    signal.addEventListener('abort', cancel, { once: true });
    let response;
    try {
      const responseFormat = validateResponseFormat(request.responseFormat);
      const reasoningControls = providerReasoningControls(request);
      // OpenAI-compatible hosts may load a model before returning response headers.
      // The ProviderRunner owns this whole admission phase with its first-token
      // deadline; a short fetch timer here would abort legitimate local model loads.
      response = await this.#fetch(`${this.profile.endpoint}/chat/completions`, {
        method: 'POST', signal: transport.signal,
        body: JSON.stringify({
          ...chatCompletionBody(this.profile, request, responseFormat, reasoningControls),
        }),
      }, 'Authenticate provider inference');
    } catch (error) {
      signal.removeEventListener('abort', cancel);
      transport.abort();
      throw normalizeProviderTransportError(error, signal);
    }
    try {
      if (!response.ok) throw await providerErrorResponse(response, this.profile.trustZone);
      if (!response.body) throw new ContractError('provider_empty_body', 'provider returned no stream');
      yield* parseSse(response.body, providerStreamByteLimit(this.limits, request), signal);
    } catch (error) {
      throw normalizeProviderTransportError(error, signal);
    } finally {
      signal.removeEventListener('abort', cancel);
      transport.abort();
    }
  }

  async #toolCallProbe(parallelToolCalls, signal) {
    let response;
    try {
      const request = toolCallProbeRequest(this.profile, parallelToolCalls);
      response = await this.#fetch(`${this.profile.endpoint}/chat/completions`, {
        method: 'POST', signal,
        body: JSON.stringify(chatCompletionBody(this.profile, request, null, {})),
      }, 'Test provider tool-call compatibility');
      if (response.ok) {
        await response.body?.cancel();
        return Object.freeze({ accepted: true, status: response.status, error: null });
      }
      const error = await providerErrorResponse(response, this.profile.trustZone);
      return Object.freeze({ accepted: false, status: response.status, error });
    } catch (error) {
      throw normalizeProviderTransportError(error, signal);
    }
  }

  #fetch(url, init, purpose) {
    return this.credentialResolver.withCredential(this.credential, {
      consumer: `provider:${this.profile.id}`, destination: this.profile.endpoint,
      purpose, authorityRef: `provider-configuration:${this.profile.id}`, sessionId: this.sessionId,
    }, (secret) => this.fetch(url, { ...init, headers: this.#headers(secret) }));
  }

  #headers(secret) {
    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
    if (secret) headers.authorization = `Bearer ${secret}`;
    return headers;
  }
}

function normalizeProviderTransportError(error, signal) {
  if (error instanceof ContractError || signal?.aborted) return error;
  const code = nestedErrorCode(error);
  const timeoutCodes = new Set(['UND_ERR_BODY_TIMEOUT', 'ERR_HTTP_REQUEST_TIMEOUT']);
  const connectionCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  ]);
  if (timeoutCodes.has(code)) {
    return new ContractError('provider_transport_idle_timeout', 'provider transport stopped receiving response data', true, { cause: error });
  }
  if (connectionCodes.has(code) || error instanceof TypeError) {
    return new ContractError('provider_transport_error', 'provider transport failed', true, { cause: error });
  }
  return new ContractError('provider_transport_error', 'provider transport failed', true, { cause: error });
}

function nestedErrorCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string' && current.code.length <= 128) return current.code;
    current = current.cause;
  }
  return null;
}

function declaredRuntime(profile) {
  return {
    contextWindowTokens: null,
    contextLimitBytes: knownPositiveInteger(profile.contextLimitBytes),
    outputLimitTokens: knownPositiveInteger(profile.outputLimitTokens),
    parallelCapacity: null,
  };
}

function runtimeFromCapabilities(capabilities, declared, source) {
  return Object.freeze({
    ...declared,
    contextWindowTokens: knownPositiveInteger(capabilities.contextLimitTokens),
    contextLimitBytes: knownPositiveInteger(capabilities.contextLimitBytes) ?? declared.contextLimitBytes,
    outputLimitTokens: knownPositiveInteger(capabilities.outputLimitTokens) ?? declared.outputLimitTokens,
    parallelCapacity: knownPositiveInteger(capabilities.parallelCapacity),
    source,
  });
}

function parseLmStudioV1(body, model, declared) {
  const entries = Array.isArray(body?.models) ? body.models.slice(0, 4096) : [];
  for (const entry of entries) {
    const instances = Array.isArray(entry?.loaded_instances) ? entry.loaded_instances.slice(0, 64) : [];
    const selected = instances.find((item) => modelIdentityMatches(model, item?.id))
      ?? (modelIdentityMatches(model, entry?.key) || modelIdentityMatches(model, entry?.selected_variant)
        ? instances[0] : null);
    const entryMatches = modelIdentityMatches(model, entry?.key)
      || modelIdentityMatches(model, entry?.selected_variant);
    if (!selected && !entryMatches) continue;
    return Object.freeze({
      ...declared,
      contextWindowTokens: knownPositiveInteger(selected?.config?.context_length)
        ?? knownPositiveInteger(entry?.max_context_length),
      outputLimitTokens: knownPositiveInteger(selected?.config?.max_output_tokens) ?? declared.outputLimitTokens,
      parallelCapacity: knownPositiveInteger(selected?.config?.parallel),
      source: 'lmstudio_v1',
    });
  }
  return null;
}

function parseLmStudioV0(body, model, declared) {
  const entries = Array.isArray(body?.data) ? body.data.slice(0, 4096) : [];
  const selected = entries.find((item) => modelIdentityMatches(model, item?.id)
    && (item?.state === undefined || item.state === 'loaded'));
  if (!selected) return null;
  return Object.freeze({
    ...declared,
    contextWindowTokens: knownPositiveInteger(selected.loaded_context_length)
      ?? knownPositiveInteger(selected.context_length) ?? knownPositiveInteger(selected.max_context_length),
    outputLimitTokens: knownPositiveInteger(selected.max_output_tokens) ?? declared.outputLimitTokens,
    parallelCapacity: knownPositiveInteger(selected.parallel),
    source: 'lmstudio_v0',
  });
}

function modelIdentityMatches(expected, candidate) {
  if (typeof expected !== 'string' || typeof candidate !== 'string') return false;
  return expected === candidate || candidate.endsWith(`/${expected}`) || expected.endsWith(`/${candidate}`);
}

function validateResponseFormat(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('provider_response_format_invalid', 'structured output format must be an object');
  }
  if (value.type === 'json_object' && Object.keys(value).every((key) => key === 'type')) {
    return Object.freeze({ type: 'json_object' });
  }
  const definition = value.json_schema;
  if (value.type !== 'json_schema' || Object.keys(value).some((key) => !['type', 'json_schema'].includes(key))
    || !definition || typeof definition !== 'object' || Array.isArray(definition)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(definition.name ?? '')
    || (definition.strict !== undefined && typeof definition.strict !== 'boolean')
    || !definition.schema || typeof definition.schema !== 'object' || Array.isArray(definition.schema)) {
    throw new ContractError('provider_response_format_invalid', 'JSON schema response format is invalid');
  }
  let encoded;
  try { encoded = JSON.stringify(value); } catch {
    throw new ContractError('provider_response_format_invalid', 'JSON schema response format is not serializable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 65_536) {
    throw new ContractError('provider_response_format_invalid', 'JSON schema response format exceeds its bound');
  }
  return Object.freeze(JSON.parse(encoded));
}

function knownPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function providerStreamByteLimit(limits, request) {
  const configuredFloor = knownPositiveInteger(limits?.maxOutputBytes) ?? MIN_PROVIDER_STREAM_BYTES;
  const outputTokens = knownPositiveInteger(request?.maxOutputTokens);
  // SSE transports commonly repeat a substantial JSON envelope for every generated
  // token. Bound that untrusted wire traffic independently from decoded model output
  // so legitimate token-by-token reasoning is not rejected merely for framing cost.
  const workloadAllowance = outputTokens === null
    ? UNDECLARED_PROVIDER_STREAM_BYTES
    : Math.min(MAX_PROVIDER_STREAM_BYTES, outputTokens * PROVIDER_STREAM_BYTES_PER_OUTPUT_TOKEN);
  return Math.min(
    MAX_PROVIDER_STREAM_BYTES,
    Math.max(MIN_PROVIDER_STREAM_BYTES, configuredFloor, workloadAllowance),
  );
}

async function* parseSse(body, maxBytes, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let total = 0;
  let terminal = false;
  for await (const chunk of body) {
    if (signal.aborted) throw new ContractError('provider_cancelled', 'provider request cancelled');
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new ContractError(
        'provider_output_too_large',
        `provider stream exceeded its ${maxBytes}-byte transport safety allowance`,
      );
    }
    // Transport liveness is distinct from semantic output. Some compatible
    // servers stream role markers, keepalives, hidden reasoning, or partial
    // tool JSON before an adapter can project a text/reasoning/tool event.
    // Surface the bounded byte receipt so supervision does not misclassify an
    // active connection as idle.
    if (chunk.byteLength > 0) yield { type: 'transport_activity', bytes: chunk.byteLength };
    buffer += decoder.decode(chunk, { stream: true });
    const split = splitEvents(buffer);
    buffer = split.remainder;
    for (const event of split.events) {
      const items = decodeSseEvent(event);
      for (const item of items) {
        if (item.type === 'terminal') terminal = true;
        yield item;
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const item of decodeSseEvent(buffer)) {
      if (item.type === 'terminal') terminal = true;
      yield item;
    }
  }
  if (!terminal) throw new ContractError('provider_missing_terminal', 'provider stream ended without terminal marker');
}

function splitEvents(buffer) {
  const normalized = buffer.replaceAll('\r\n', '\n');
  const parts = normalized.split('\n\n');
  return { events: parts.slice(0, -1), remainder: parts.at(-1) ?? '' };
}

function decodeSseEvent(block) {
  const data = block.split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart()).join('\n');
  if (data.length === 0) return [];
  if (data === '[DONE]') return [{ type: 'terminal', finishReason: 'done', usage: null }];
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ContractError('provider_malformed_stream', 'provider emitted malformed JSON');
  }
  return decodeChunk(value);
}

function decodeChunk(value) {
  if (value?.error) {
    if (isContextLimitError(value.error)) {
      throw new ContractError('provider_context_limit', 'provider rejected the request because its context limit was exceeded');
    }
    if (isImageUnsupportedError(value.error)) {
      throw new ContractError('provider_image_unsupported', 'provider explicitly rejected image input');
    }
    const status = Number(value.error.code);
    const retryable = Number.isInteger(status) && (status === 408 || status === 429 || status >= 500);
    const grammarFailure = isGrammarFailure(value.error);
    throw new ContractError(
      grammarFailure ? 'provider_tool_schema_rejected' : retryable ? 'provider_transient' : 'provider_rejected',
      grammarFailure
        ? 'provider could not compile the supplied tool schema into a valid grammar'
        : 'provider reported an error during streaming',
      retryable,
    );
  }
  if (!value || !Array.isArray(value.choices)) {
    throw new ContractError('provider_malformed_stream', 'provider chunk lacks choices');
  }
  const items = [];
  for (const choice of value.choices.slice(0, 16)) {
    const delta = choice.delta ?? {};
    if (delta.role !== undefined && delta.role !== 'assistant') {
      throw new ContractError('provider_role_invalid', 'provider emitted a non-assistant response role');
    }
    const reasoningField = typeof delta.reasoning === 'string' && delta.reasoning.length > 0
      ? 'reasoning' : 'reasoning_content';
    const reasoning = delta[reasoningField];
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      items.push({ type: 'reasoning', text: reasoning, field: reasoningField });
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      items.push({ type: 'text', text: delta.content });
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      items.push({ type: 'tool_fragment', fragments: delta.tool_calls });
    }
    const unrecognized = unrecognizedDeltaEvent(delta);
    if (unrecognized) items.push(unrecognized);
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      items.push({ type: 'metadata', finishReason: choice.finish_reason });
    }
  }
  if (value.usage) items.push({ type: 'usage', usage: sanitizeProviderUsage(value.usage) });
  return items;
}

function providerError(status, message, retryAfterMs = null) {
  const transient = status === 408 || status === 429 || status >= 500;
  const error = new ContractError(transient ? 'provider_transient' : 'provider_rejected', message, transient);
  if (transient && retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
  return error;
}

async function providerErrorResponse(response, trustZone) {
  let body = null;
  try {
    body = await boundedResponseJson(response);
  } catch { /* response bodies are untrusted and optional */ }
  if (isImageUnsupportedError(body)) {
    return new ContractError('provider_image_unsupported', 'provider explicitly rejected image input');
  }
  if (response.status === 413 || isContextLimitError(body)) {
    return new ContractError('provider_context_limit', 'provider rejected the request because its context limit was exceeded');
  }
  if (isGrammarFailure(body)) {
    return new ContractError('provider_tool_schema_rejected', 'provider could not compile the supplied tool schema into a valid grammar');
  }
  return providerError(response.status, 'provider request failed', providerRetryAfterMs(response, trustZone));
}

const IMAGE_UNSUPPORTED_CODES = new Set([
  'unsupported_image', 'image_not_supported', 'unsupported_content_type',
  'unsupported_image_input', 'vision_not_supported', 'multimodal_not_supported',
]);

function isImageUnsupportedError(value) {
  const fields = boundedErrorStrings(value);
  if (fields.some((item) => IMAGE_UNSUPPORTED_CODES.has(item.toLowerCase().replaceAll('-', '_')))) return true;
  const text = fields.join(' ').toLowerCase();
  return [
    /(?:image|vision|multimodal).{0,64}(?:not supported|unsupported|not available|not enabled)/u,
    /(?:does not|doesn't|cannot|can't).{0,48}(?:support|accept|process).{0,32}(?:image|vision|multimodal)/u,
    /(?:unsupported|invalid) content (?:type|part).{0,48}image/u,
    /(?:text[- ]only|only supports? text).{0,48}(?:model|input|content)?/u,
  ].some((pattern) => pattern.test(text));
}

function isGrammarFailure(value) {
  const text = boundedErrorStrings(value).join(' ').toLowerCase();
  return /(?:failed|error).{0,64}(?:parse|compile).{0,32}grammar/u.test(text)
    || /failed to initialize samplers.{0,96}grammar/u.test(text);
}

const CONTEXT_LIMIT_CODES = new Set([
  'context_length_exceeded', 'context_window_exceeded', 'context_size_exceeded',
  'input_too_long', 'prompt_too_long', 'max_context_length_exceeded',
  'maximum_context_length_exceeded', 'tokens_exceeded',
]);

function isContextLimitError(value) {
  const fields = boundedErrorStrings(value);
  if (fields.some((item) => CONTEXT_LIMIT_CODES.has(item.toLowerCase().replaceAll('-', '_')))) return true;
  const text = fields.join(' ').toLowerCase();
  return [
    /(?:maximum|max) context (?:length|window|size).{0,96}(?:exceed|token|larger|greater)/u,
    /context (?:length|window|size).{0,96}(?:exceed|too (?:long|large)|overflow|limit)/u,
    /(?:input|prompt).{0,64}(?:too (?:long|large)|exceed).{0,64}(?:context|token|limit|length)/u,
    /(?:requested|provided|input).{0,64}(?:tokens?|token count).{0,96}(?:exceed|greater|larger|maximum|max)/u,
    /(?:number|amount) of tokens.{0,96}(?:exceed|greater|larger|context)/u,
    /request.{0,64}exceed.{0,96}(?:available )?context (?:length|window|size)/u,
    /(?:kv|k-v) cache.{0,64}(?:insufficient|not enough|exhausted).{0,64}(?:context|token|capacity)?/u,
  ].some((pattern) => pattern.test(text));
}

function boundedErrorStrings(value) {
  const result = []; const pending = [value]; let visited = 0; let bytes = 0;
  while (pending.length > 0 && visited < 128 && bytes < 32_768) {
    const item = pending.pop(); visited += 1;
    if (typeof item === 'string' || typeof item === 'number') {
      const text = String(item).slice(0, 4096); bytes += Buffer.byteLength(text, 'utf8'); result.push(text);
    } else if (item && typeof item === 'object') {
      pending.push(...Object.values(item).slice(0, 32));
    }
  }
  return result;
}

async function boundedResponseJson(response, maxBytes = 1_048_576) {
  if (!response.body) throw new ContractError('provider_metadata_invalid', 'provider metadata response has no body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = ''; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new ContractError('provider_metadata_too_large', 'provider metadata exceeded its byte bound');
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  try { return JSON.parse(text); }
  catch { throw new ContractError('provider_metadata_invalid', 'provider metadata was not valid JSON'); }
}
