// SPDX-License-Identifier: Apache-2.0
/** Direct bounded generation calls for OpenAI, Anthropic, and Google wire forms. */

export type ProviderCallOutcome = { ok: true; text: string } | {
  ok: false; status: number; code: string; message: string;
};

export interface DirectCallInput {
  model: { id: string; providerID: string };
  provider: { id: string; name?: unknown; options?: unknown };
  credential: string;
  baseURL: URL | null;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  responseSchema?: Record<string, unknown>;
  jsonMode?: boolean;
  sessionID: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function directCallWire(providerID: string): 'openai' | 'anthropic' | 'google' | null {
  if (providerID === 'openai') return 'openai';
  if (providerID === 'anthropic') return 'anthropic';
  if (providerID === 'google') return 'google';
  return null;
}

export async function callSmallModelDirect(
  input: DirectCallInput,
  fetcher: typeof fetch = fetch,
): Promise<ProviderCallOutcome> {
  const wire = directCallWire(input.model.providerID);
  if (wire === null || input.baseURL === null || input.credential === '') {
    return { ok: false, status: 422, code: 'provider-unsupported', message: '' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const endpoint = buildEndpoint(input.baseURL, input.model, wire);
    const signal = input.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, input.signal]);
    let response: Response;
    let text: string;
    let attempt: DirectCallInput = input;
    while (true) {
      response = await fetcher(endpoint, { method: 'POST',
        headers: headers(input.model.providerID, input.credential, input.sessionID),
        body: JSON.stringify(body(attempt, wire)), signal });
      text = await boundedBody(response);
      if (response.ok || attempt.responseSchema === undefined || !schemaRefusal(response.status, text)) break;
      attempt = { ...input, responseSchema: undefined, jsonMode: true };
    }
    if (!response.ok) return {
      ok: false,
      status: response.status >= 400 && response.status <= 499 ? response.status : 502,
      code: response.status === 401 || response.status === 403 ? 'provider-refused' : 'provider-failed',
      message: '',
    };
    return { ok: true, text };
  } catch (error) {
    if ((error instanceof DOMException || error instanceof Error) && error.name === 'AbortError') {
      if (input.signal?.aborted) return { ok: false, status: 499, code: 'cancelled', message: '' };
      return { ok: false, status: 504, code: 'generation-timeout', message: '' };
    }
    return { ok: false, status: 502, code: 'provider-failed', message: '' };
  } finally {
    clearTimeout(timeout);
  }
}

function schemaRefusal(status: number, raw: string): boolean {
  if (status !== 400 && status !== 422) return false;
  let message = raw.toLowerCase();
  try { message = JSON.stringify(JSON.parse(raw)).toLowerCase(); } catch { /* provider may return plain text */ }
  return /(?:json.?schema|response.?schema|response.?format|structured.?output|output_config).{0,100}(?:unsupported|not support|invalid|unknown|not allowed|unrecognized)|(?:unsupported|not support|invalid|unknown|not allowed|unrecognized).{0,100}(?:json.?schema|response.?schema|response.?format|structured.?output|output_config)/u.test(message);
}

function buildEndpoint(baseURL: URL, model: { id: string }, wire: 'openai' | 'anthropic' | 'google'): string {
  const target = new URL(baseURL);
  let suffix = wire === 'openai' ? '/chat/completions' : wire === 'anthropic' ? '/messages' : '';
  if (wire === 'google') {
    if (!target.pathname.endsWith('/models')) {
      suffix = `/models/${model.id}:generateContent`;
    } else {
      suffix = `/${model.id}:generateContent`;
    }
  }
  target.pathname = `${target.pathname.replace(/\/+$/u, '')}${suffix}`;
  return target.toString();
}

function headers(providerID: string, credential: string, sessionID: string | null): Headers {
  const value = new Headers({ 'content-type': 'application/json' });
  if (providerID === 'anthropic') {
    value.set('x-api-key', credential);
    value.set('anthropic-version', '2023-06-01');
  } else if (providerID === 'google') {
    value.set('x-goog-api-key', credential);
  } else {
    value.set('authorization', `Bearer ${credential}`);
    if (sessionID) value.set('x-opencode-session', sessionID);
  }
  return value;
}

function body(input: DirectCallInput, wire: 'openai' | 'anthropic' | 'google'): Record<string, unknown> {
  const messages = input.system === ''
    ? [{ role: 'user', content: input.prompt }]
    : [
      { role: 'system', content: input.system },
      { role: 'user', content: input.prompt },
    ];
  if (wire === 'openai') {
    return { model: input.model.id, messages, max_completion_tokens: input.maxOutputTokens, stream: false,
      ...(input.responseSchema !== undefined ? { response_format: { type: 'json_schema', json_schema: {
        name: 'walkthrough', strict: true, schema: input.responseSchema,
      } } } : input.jsonMode ? { response_format: { type: 'json_object' } } : {}) };
  }
  if (wire === 'anthropic') {
    return {
      model: input.model.id, max_tokens: input.maxOutputTokens, stream: false,
      ...(input.system === '' ? {} : { system: input.system }),
      ...(input.responseSchema === undefined ? {} : { output_config: { format: { type: 'json_schema', schema: input.responseSchema } } }),
      messages: [{ role: 'user', content: input.prompt }],
    };
  }
  return {
    contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
    generationConfig: {
      maxOutputTokens: input.maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
      responseFormat: { text: { mimeType: 'application/json',
        ...(input.responseSchema === undefined ? {} : { schema: input.responseSchema }) } },
    },
  };
}

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let value = '';
  while (value.length <= 1_048_576) {
    const next = await reader.read();
    if (next.done) return value + decoder.decode();
    value += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return value.slice(0, 1_048_576);
}

export function parseSmallModelResponse(raw: string, wire: 'openai' | 'anthropic' | 'google'): string | null {
  try {
    const record = JSON.parse(raw);
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
    const shape = record as Record<string, unknown>;
    if (wire === 'openai') {
      const choices = Array.isArray(shape.choices) ? shape.choices : [];
      const first = choices[0];
      const message = unwrap(first).message;
      const text = textFrom(unwrap(message).content);
      return text !== null ? normalize(text) : null;
    }
    if (wire === 'anthropic') {
      const value = textFrom(unwrap(shape).content);
      return value !== null ? normalize(value) : null;
    }
    const candidates = Array.isArray(shape.candidates) ? shape.candidates : [];
    const first = unwrap(candidates[0]);
    const contents = unwrap(first).content;
    const parts = Array.isArray(unwrap(contents).parts) ? unwrap(contents).parts as unknown[] : [];
    const joined = parts.flatMap((part) => {
      const text = object(part).text;
      return typeof text === 'string' ? [text] : [];
    }).join('\n');
    return joined === '' ? null : normalize(joined);
  } catch {
    return null;
  }
}

export function outputExhausted(raw: string, wire: 'openai' | 'anthropic' | 'google'): boolean {
  try {
    const shape = object(JSON.parse(raw));
    if (wire === 'openai') {
      const first = object(Array.isArray(shape.choices) ? shape.choices[0] : null);
      return first.finish_reason === 'length';
    }
    if (wire === 'anthropic') return shape.stop_reason === 'max_tokens';
    const first = object(Array.isArray(shape.candidates) ? shape.candidates[0] : null);
    return first.finishReason === 'MAX_TOKENS';
  } catch {
    return false;
  }
}

function textFrom(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.flatMap((part) => `${object(part).text ?? ''}`).join('\n');
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function normalize(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}

function unwrap(value: unknown): Record<string, unknown> {
  return object(value);
}
