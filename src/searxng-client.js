// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { normalizeSearxngEndpoint } from './web-search-config.js';
import { VERSION } from './product.js';

const MAX_RESPONSE_BYTES = 2_097_152;

export class SearxngClient {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async test(endpoint, signal) {
    const result = await this.search(endpoint, { query: 'SearXNG', limit: 1 }, signal);
    return Object.freeze({ ok: true, endpoint: normalizeSearxngEndpoint(endpoint), results: result.results.length });
  }

  async search(endpoint, input, signal) {
    const url = searchUrl(endpoint, input);
    const response = await this.fetch(url, {
      method: 'GET', headers: { accept: 'application/json', 'user-agent': `NotNativeAgent/${VERSION}` },
      signal: combinedSignal(signal, this.timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      throw new ContractError('web_search_http_error', `SearXNG returned HTTP ${response.status}`);
    }
    const value = await boundedJson(response, MAX_RESPONSE_BYTES);
    if (!Array.isArray(value?.results)) {
      throw new ContractError('web_search_response_invalid', 'SearXNG did not return a JSON search result list');
    }
    const limit = input.limit ?? 8;
    return Object.freeze({
      query: input.query, endpoint: normalizeSearxngEndpoint(endpoint),
      results: Object.freeze(value.results.slice(0, limit).map(normalizeResult).filter(Boolean)),
      suggestions: Object.freeze(Array.isArray(value.suggestions) ? value.suggestions.filter(shortString).slice(0, 8) : []),
    });
  }
}

function searchUrl(endpoint, input) {
  const url = new URL(`${normalizeSearxngEndpoint(endpoint)}/search`);
  url.searchParams.set('q', input.query);
  url.searchParams.set('format', 'json');
  if (input.categories) url.searchParams.set('categories', input.categories);
  if (input.language) url.searchParams.set('language', input.language);
  if (input.page) url.searchParams.set('pageno', String(input.page));
  if (input.time_range) url.searchParams.set('time_range', input.time_range);
  if (input.safe_search !== undefined) url.searchParams.set('safesearch', String(input.safe_search));
  return url;
}

function normalizeResult(value) {
  if (!value || !shortString(value.url) || !shortString(value.title)) return null;
  return Object.freeze({
    title: value.title.slice(0, 512), url: value.url.slice(0, 4096),
    content: shortString(value.content) ? value.content.slice(0, 4096) : '',
    engine: shortString(value.engine) ? value.engine.slice(0, 128) : undefined,
    score: Number.isFinite(value.score) ? value.score : undefined,
  });
}

async function boundedJson(response, maximum) {
  if (!response.body?.getReader) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new ContractError('web_search_response_too_large', 'SearXNG response exceeded the size bound');
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new ContractError('web_search_response_invalid', 'SearXNG response was not valid UTF-8 JSON');
  }
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function shortString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32_768;
}
