// SPDX-License-Identifier: Apache-2.0

const TOOL = Object.freeze({ SEARCH: 'web.search', BROWSE: 'web.browse', FETCH: 'web.fetch' });
const SOURCE = Object.freeze({
  INVALID: 'invalid', MODEL: 'model_unverified', FETCH: 'fetch', BROWSER: 'browser', SEARCH: 'search', USER: 'user',
});
const SOURCE_PRIORITY = Object.freeze({
  [SOURCE.MODEL]: 0, [SOURCE.FETCH]: 1, [SOURCE.BROWSER]: 2, [SOURCE.SEARCH]: 3, [SOURCE.USER]: 4,
});
const NONTERMINAL_STATUSES = new Set(['running']);
const SUCCESS_STATUSES = new Set(['succeeded', 'duplicate_ignored']);

export class WebUrlProvenance {
  constructor(prompt = '') {
    this.sources = new Map();
    this.failed = new Set();
    for (const url of extractWebUrls(prompt)) this.remember(url, SOURCE.USER);
  }

  remember(value, source) {
    const url = normalizeWebUrl(value);
    if (!url) return null;
    const current = this.sources.get(url);
    if (!current || (SOURCE_PRIORITY[source] ?? 0) > (SOURCE_PRIORITY[current] ?? 0)) {
      this.sources.set(url, source);
    }
    return url;
  }

  classify(value) {
    const url = normalizeWebUrl(value);
    if (!url) return { url: null, source: SOURCE.INVALID, verified: false };
    const source = this.sources.get(url) ?? SOURCE.MODEL;
    return { url, source, verified: source !== SOURCE.MODEL };
  }

  hasFailed(value) {
    const url = normalizeWebUrl(value);
    return Boolean(url && this.failed.has(url));
  }

  observe(request, result) {
    const toolName = request?.toolName;
    if (toolName === TOOL.SEARCH && result?.status === 'succeeded') {
      for (const url of searchResultUrls(result.content)) this.remember(url, SOURCE.SEARCH);
      return;
    }
    if (toolName === TOOL.BROWSE && result?.status === 'succeeded') {
      this.remember(result.metadata?.url ?? request.args?.url, SOURCE.BROWSER);
      return;
    }
    if (toolName !== TOOL.FETCH) return;
    const url = this.remember(request.args?.url, this.classify(request.args?.url).source);
    if (!url) return;
    if (result?.status === 'succeeded') {
      this.remember(result.metadata?.finalUrl ?? result.metadata?.url ?? url, SOURCE.FETCH);
    } else if (result?.status && !NONTERMINAL_STATUSES.has(result.status) && !SUCCESS_STATUSES.has(result.status)) {
      this.failed.add(url);
    }
  }
}

export function normalizeWebUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim().replace(/[),.;!?]+$/u, ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    // Fragments identify a client-side view, not a distinct network resource, so provenance is resource-scoped.
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

export function extractWebUrls(text) {
  if (typeof text !== 'string') return [];
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/giu) ?? [];
  return [...new Set(matches.map(normalizeWebUrl).filter(Boolean))];
}

function searchResultUrls(content) {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed?.results) ? parsed.results.map((result) => result?.url).filter(Boolean) : [];
  } catch {
    return [];
  }
}
