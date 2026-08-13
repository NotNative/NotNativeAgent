// SPDX-License-Identifier: Apache-2.0

const SOURCE_PRIORITY = Object.freeze({
  model_unverified: 0, fetch: 1, browser: 2, search: 3, user: 4,
});

export class WebUrlProvenance {
  constructor(prompt = '') {
    this.sources = new Map();
    this.failed = new Set();
    for (const url of extractWebUrls(prompt)) this.remember(url, 'user');
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
    if (!url) return { url: null, source: 'invalid', verified: false };
    const source = this.sources.get(url) ?? 'model_unverified';
    return { url, source, verified: source !== 'model_unverified' };
  }

  hasFailed(value) {
    const url = normalizeWebUrl(value);
    return Boolean(url && this.failed.has(url));
  }

  observe(request, result) {
    const toolName = request?.toolName;
    if (toolName === 'web.search' && result?.status === 'succeeded') {
      for (const url of searchResultUrls(result.content)) this.remember(url, 'search');
      return;
    }
    if (toolName === 'web.browse' && result?.status === 'succeeded') {
      this.remember(result.metadata?.url ?? request.args?.url, 'browser');
      return;
    }
    if (toolName !== 'web.fetch') return;
    const url = this.remember(request.args?.url, this.classify(request.args?.url).source);
    if (!url) return;
    if (result?.status === 'succeeded') {
      this.remember(result.metadata?.finalUrl ?? result.metadata?.url ?? url, 'fetch');
    } else if (['failed', 'invalid_request', 'timed_out'].includes(result?.status)) {
      this.failed.add(url);
    }
  }
}

export function normalizeWebUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value.trim().replace(/[),.;!?]+$/u, ''));
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
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
