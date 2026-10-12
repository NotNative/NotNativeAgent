// SPDX-License-Identifier: Apache-2.0
/**
 * Same-origin preview proxy (F7 scoped capability): serves an admitted dev
 * server through the NND origin so the operator's browser tab can inspect,
 * annotate, and DOM-capture the preview without Electron. Only ports that
 * dev-server discovery currently reports are proxied; loopback only, no
 * operator credentials forwarded.
 */
import type { Context, Hono } from 'hono';

const MAX_HTML_BUFFER_BYTES = 2_000_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

export interface PreviewProxyOptions {
  allowedPorts: () => Promise<readonly number[]>;
  fetcher?: typeof fetch;
}

function suffixTarget(port: number, suffix: string, query: string): string | null {
  const rest = suffix.replace(/^\/+/u, '');
  try {
    return new URL('http://127.0.0.1:' + port + '/' + rest + query).href;
  } catch { return null; }
}

/** Drop framing denials so the app tab may host the preview same-origin;
 * keep every other response byte untouched. */
function framingHeaders(headers: Headers): Headers {
  const outgoing = new Headers();
  let sawCsp = false;
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'x-frame-options') continue;
    if (lower === 'content-security-policy') {
      sawCsp = true;
      const directives = value.split(';').filter((directive) => {
        const name = directive.trim().split(/\s+/u)[0]?.toLowerCase();
        return name !== 'frame-ancestors' && name !== 'sandbox' && directive.trim() !== '';
      });
      directives.push("frame-ancestors 'self'");
      outgoing.set(key, directives.join('; '));
      continue;
    }
    outgoing.set(key, value);
  }
  if (!sawCsp) outgoing.set('content-security-policy', "frame-ancestors 'self'");
  return outgoing;
}

async function proxyThrough(context: Context, port: number, suffix: string,
  options: PreviewProxyOptions): Promise<Response> {
  const allowed = await options.allowedPorts();
  if (!allowed.includes(port)) return context.body('That port is not an available dev server', 403);
  const incoming = context.req.raw;
  const queryIndex = incoming.url.indexOf('?');
  const target = suffixTarget(port, suffix, queryIndex >= 0 ? incoming.url.slice(queryIndex) : '');
  if (!target) return context.body('Invalid preview proxy target', 400);
  const headers = new Headers(incoming.headers);
  for (const key of ['cookie', 'authorization', 'x-nnd-browser-token']) headers.delete(key);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(target, {
      method: incoming.method, headers,
      body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : incoming.body,
      redirect: 'manual', signal: AbortSignal.timeout(30_000), duplex: 'half',
    } as RequestInit);
  } catch {
    return context.body('Preview proxy target unreachable', 502);
  }
  const outgoing = framingHeaders(response.headers);
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html')) {
    return new Response(response.body, { status: response.status, headers: outgoing });
  }
  const buffered = await response.arrayBuffer();
  if (buffered.byteLength > MAX_HTML_BUFFER_BYTES) {
    return context.body('Preview document exceeds the proxy buffer', 502);
  }
  return new Response(buffered, { status: response.status, headers: outgoing });
}

export function registerPreviewProxyRoutes(app: Hono, options: PreviewProxyOptions): void {
  app.all('/api/preview-proxy/:port/*', (c) =>
    proxyThrough(c, Number(c.req.param('port')), c.req.param('0') ?? '/', options));
  app.all('/api/preview-proxy/:port', (c) => proxyThrough(c, Number(c.req.param('port')), '/', options));
}
