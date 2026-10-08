// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side transport to an authenticated NNA harness. NNA credentials
 * deliberately stay in this process; browser requests only reach `/api`.
 */
import { harnessError, type HarnessAdapter } from './adapter.ts';

const REQUEST_TIMEOUT_MS = 30_000;
// Admission persists and re-reads native workspace grants; allow its longer
// bounded transaction while retaining the ordinary request budget.
const WORKSPACE_ADMISSION_TIMEOUT_MS = 60_000;
// NNA's explicit walkthrough generation has a 45-second model deadline.
// Preserve the shorter bound for ordinary API calls while allowing that
// governed read-only request to finish or report its own deadline.
const WALKTHROUGH_TIMEOUT_MS = 55_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface NnaHarnessOptions {
  endpoint: string;
  token: string;
  principal: string | (() => string);
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export function createNnaHarnessAdapter(options: NnaHarnessOptions): HarnessAdapter {
  const endpoint = parseEndpoint(options.endpoint);
  const token = requireToken(options.token);
  const principal = principalSupplier(options.principal);
  const requestFetch = options.fetch ?? globalThis.fetch;
  return { handle: async (request) => {
    let currentPrincipal: string;
    try {
      currentPrincipal = principal();
    } catch {
      // A launcher can fail while minting fresh authority. Do not turn that
      // internal failure into an unhandled route error or forward credentials.
      return harnessError('NNA harness principal is unavailable', 502);
    }
    return forward(request, endpoint, token, currentPrincipal, requestFetch, options.signal);
  } };
}

export function createNnaHarnessAdapterFromEnvironment(environment: NodeJS.ProcessEnv = process.env): HarnessAdapter {
  return createNnaHarnessAdapter({
    endpoint: environment.NNA_HARNESS_URL ?? '', token: environment.NNA_INTEGRATION_TOKEN ?? '',
    principal: environment.NNA_PRINCIPAL ?? '',
  });
}

async function forward(request: Request, endpoint: URL, token: string, principal: string, requestFetch: typeof fetch, generationSignal?: AbortSignal): Promise<Response> {
  const source = new URL(request.url);
  const path = source.pathname.replace(/^\/api(?=\/|$)/u, '') || '/';
  // Do not compose a URL from an untrusted path string: `/api//host` would
  // otherwise become a scheme-relative URL and receive NNA credentials.
  const target = new URL(endpoint);
  target.pathname = path;
  target.search = source.search;
  const headers = forwardedHeaders(request.headers, token, principal);
  const controller = new AbortController();
  // The browser may close an SSE stream after the upstream has sent headers.
  // Keep its signal attached to fetch for the stream lifetime so NNA can
  // release the subscriber instead of holding a ghost connection.
  const signal = AbortSignal.any([controller.signal, request.signal, ...(generationSignal ? [generationSignal] : [])]);
  const timeoutMs = /^\/v1\/nnd\/workspaces\/admissions(?:\/|$)/u.test(path)
    ? WORKSPACE_ADMISSION_TIMEOUT_MS
    : request.method === 'POST' && /^\/v1\/nnd\/sessions\/[^/]+\/walkthrough$/u.test(path)
      ? WALKTHROUGH_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await requestFetch(target, {
      method: request.method, headers, redirect: 'error', signal,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
    } as RequestInit);
    return safeResponse(response);
  } catch (error) {
    if (request.signal.aborted) return harnessError('NND request was cancelled', 499);
    return harnessError(
      error instanceof DOMException && error.name === 'AbortError'
        ? 'NNA harness request timed out'
        : 'NNA harness is unavailable',
      error instanceof DOMException && error.name === 'AbortError' ? 504 : 502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function parseEndpoint(value: string): URL {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error('NNA_HARNESS_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('NNA_HARNESS_URL must be a credential-free HTTP(S) origin');
  }
  return endpoint;
}

function requireToken(value: string): string {
  // The integration service issues base64url tokens. Enforcing that wire
  // format here also prevents a malformed attach token from making header
  // construction throw after the browser has already reached this adapter.
  if (!/^[A-Za-z0-9_-]{32,512}$/u.test(value)) {
    throw new Error('NNA_INTEGRATION_TOKEN must be a bounded integration credential');
  }
  return value;
}

function requirePrincipal(value: string): string {
  if (!value || value.length > 16_384 || !BASE64URL.test(value)) {
    throw new Error('NNA_PRINCIPAL must be a bounded base64url principal envelope');
  }
  return value;
}

function principalSupplier(value: NnaHarnessOptions['principal']): () => string {
  if (typeof value === 'string') {
    const principal = requirePrincipal(value);
    return () => principal;
  }
  if (typeof value !== 'function') throw new Error('NNA principal supplier is required');
  return () => requirePrincipal(value());
}

function forwardedHeaders(source: Headers, token: string, principal: string): Headers {
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'last-event-id', 'x-nnd-directory', 'x-nnd-directory-encoding']) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('authorization', `Bearer ${token}`);
  headers.set('x-nna-principal', principal);
  return headers;
}

function safeResponse(source: Response): Response {
  const headers = new Headers(source.headers);
  headers.delete('set-cookie');
  // The harness may echo request headers. Neither authority value belongs in
  // the browser response even when the upstream endpoint is otherwise trusted.
  headers.delete('authorization');
  headers.delete('x-nna-principal');
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers });
}
