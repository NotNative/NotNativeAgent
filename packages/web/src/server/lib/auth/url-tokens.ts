// SPDX-License-Identifier: Apache-2.0
/**
 * Runtime URL tokens (doc 08 section 2.6): `oc_url_token` is the doc-literal
 * query param; the coordinated `nn_url_token` alias (DECISIONS brand seam)
 * is accepted on the same targets. WS upgrades + fixed GET allowlist only —
 * anything else rejects the token and falls through to cookie/open checks.
 */
export const URL_TOKEN_QUERY_ALIASES = ['oc_url_token', 'nn_url_token'] as const;

const URL_TOKEN_GET_EXACT = new Set([
  '/api/event', '/api/global/event',
  '/api/openchamber/events', '/api/notnative/events',
  '/api/openchamber/realtime-proxy/sse',
  '/api/notifications/stream',
  '/api/fs/raw', '/api/fs/serve',
]);
const URL_TOKEN_GET_PREFIXES = ['/api/fs/serve/', '/api/preview/proxy/'];
const URL_TOKEN_GET_PATTERN = /\/api\/projects\/[^/]+\/icon$/u;
const URL_TOKEN_WS_EXACT = new Set([
  '/api/event/ws', '/api/global/event/ws',
  '/api/openchamber/realtime-proxy/ws',
  '/api/terminal/ws', '/api/dictation/ws', '/api/dev-tunnel',
]);

export function urlTokenTargetAllowed(method: string, pathname: string, upgrade: boolean): boolean {
  if (upgrade) return URL_TOKEN_WS_EXACT.has(pathname);
  if (method !== 'GET') return false;
  if (URL_TOKEN_GET_EXACT.has(pathname)) return true;
  if (URL_TOKEN_GET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return URL_TOKEN_GET_PATTERN.test(pathname);
}

export function firstQueryParam(url: URL): string | null {
  for (const alias of URL_TOKEN_QUERY_ALIASES) {
    const value = url.searchParams.get(alias);
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}
