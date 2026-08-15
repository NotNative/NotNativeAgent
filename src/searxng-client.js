// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { normalizeSearxngEndpoint } from './web-search-config.js';
import { VERSION } from './product.js';

const MAX_RESPONSE_BYTES = 2_097_152;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESULT_LIMIT = 8;
const MAX_SUGGESTIONS = 8;
const MAX_TITLE_CHARACTERS = 512;
const MAX_URL_CHARACTERS = 4096;
const MAX_CONTENT_CHARACTERS = 4096;
const MAX_ENGINE_CHARACTERS = 128;
const MAX_SOURCE_STRING_CHARACTERS = 32_768;

export class SearxngClient {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async test(endpoint, signal) {
    const result = await this.search(endpoint, { query: 'SearXNG', limit: 1 }, signal);
    return Object.freeze({ ok: true, endpoint: normalizeSearxngEndpoint(endpoint), results: result.results.length });
  }

  async search(endpoint, input, signal) {
    const url = searchUrl(endpoint, input);
    let response;
    try {
      response = await this.fetch(url, {
        method: 'GET', headers: { accept: 'application/json', 'user-agent': `NotNativeAgent/${VERSION}` },
        signal: combinedSignal(signal, this.timeoutMs), redirect: 'error',
      });
    } catch (error) {
      if (error instanceof ContractError) throw error;
      const code = signal?.aborted ? 'web_search_cancelled' : 'web_search_request_failed';
      const failure = new ContractError(code, signal?.aborted ? 'WebSearch was cancelled' : 'SearXNG request failed');
      failure.cause = error;
      throw failure;
    }
    if (!response.ok) {
      throw new ContractError('web_search_http_error', `SearXNG returned HTTP ${response.status}`);
    }
    const value = await boundedJson(response, MAX_RESPONSE_BYTES);
    if (!Array.isArray(value?.results)) {
      throw new ContractError('web_search_response_invalid', 'SearXNG did not return a JSON search result list');
    }
    const limit = input.limit ?? DEFAULT_RESULT_LIMIT;
    return Object.freeze({
      query: input.query, endpoint: normalizeSearxngEndpoint(endpoint),
      results: Object.freeze(value.results.slice(0, limit).map(normalizeResult).filter(Boolean)),
      suggestions: Object.freeze(Array.isArray(value.suggestions) ? value.suggestions.filter(shortString).slice(0, MAX_SUGGESTIONS) : []),
    });
  }
}

function searchUrl(endpoint, input) {
  const url = new URL(`${normalizeSearxngEndpoint(endpoint)}/search`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('format', 'json');
  if (input.categories) url.searchParams.set('categories', input.categories);
  if (input.language) url.searchParams.set('language', input.language);
  if (input.page !== undefined) {
    if (!Number.isSafeInteger(input.page) || input.page < 1) throw new ContractError('web_search_page_invalid', 'SearXNG page must be a positive integer');
    url.searchParams.set('pageno', String(input.page));
  }
  if (input.time_range) url.searchParams.set('time_range', input.time_range);
  if (input.safe_search !== undefined) url.searchParams.set('safesearch', String(input.safe_search));
  return url;
}

function normalizeResult(value) {
  if (!value || !shortString(value.url) || !shortString(value.title)) return null;
  return Object.freeze({
    title: truncateCharacters(value.title, MAX_TITLE_CHARACTERS),
    url: truncateCharacters(value.url, MAX_URL_CHARACTERS),
    content: shortString(value.content) ? truncateCharacters(value.content, MAX_CONTENT_CHARACTERS) : '',
    engine: shortString(value.engine) ? truncateCharacters(value.engine, MAX_ENGINE_CHARACTERS) : undefined,
    score: Number.isFinite(value.score) ? value.score : undefined,
  });
}

async function boundedJson(response, maximum) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximum) throw new ContractError('web_search_response_too_large', 'SearXNG response exceeded the size bound');
    return parseJson(text);
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximum);
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new ContractError('web_search_response_too_large', 'SearXNG response exceeded the size bound');
    }
    bytes.set(value, length - value.length);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); } catch {
    throw new ContractError('web_search_response_invalid', 'SearXNG response was not valid UTF-8 JSON');
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function shortString(value) {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= MAX_SOURCE_STRING_CHARACTERS;
}

function truncateCharacters(value, maximum) { return Array.from(value).slice(0, maximum).join(''); }

function parseJson(value) {
  try { return JSON.parse(value); }
  catch { throw new ContractError('web_search_response_invalid', 'SearXNG response was not valid UTF-8 JSON'); }
}
