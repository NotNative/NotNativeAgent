// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side transport to an authenticated NNA harness. NNA credentials
 * deliberately stay in this process; browser requests only reach `/api`.
 */
import { harnessError, type HarnessAdapter } from './adapter.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;

export interface NnaHarnessOptions {
  endpoint: string;
  token: string;
  principal: string;
  fetch?: typeof globalThis.fetch;
}

export function createNnaHarnessAdapter(options: NnaHarnessOptions): HarnessAdapter {
  const endpoint = parseEndpoint(options.endpoint);
  const token = requireToken(options.token);
  const principal = requirePrincipal(options.principal);
  const requestFetch = options.fetch ?? globalThis.fetch;
  return { handle: async (request) => forward(request, endpoint, token, principal, requestFetch) };
}

export function createNnaHarnessAdapterFromEnvironment(environment: NodeJS.ProcessEnv = process.env): HarnessAdapter {
  return createNnaHarnessAdapter({
    endpoint: environment.NNA_HARNESS_URL ?? '', token: environment.NNA_INTEGRATION_TOKEN ?? '',
    principal: environment.NNA_PRINCIPAL ?? '',
  });
}

async function forward(request: Request, endpoint: URL, token: string, principal: string, requestFetch: typeof fetch): Promise<Response> {
  const source = new URL(request.url);
  const path = source.pathname.replace(/^\/api(?=\/|$)/u, '') || '/';
  // Do not compose a URL from an untrusted path string: `/api//host` would
  // otherwise become a scheme-relative URL and receive NNA credentials.
  const target = new URL(endpoint);
  target.pathname = path;
  target.search = source.search;
  const headers = forwardedHeaders(request.headers, token, principal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await requestFetch(target, {
      method: request.method, headers, redirect: 'error', signal: controller.signal,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body, duplex: 'half' }),
    } as RequestInit);
    return safeResponse(response);
  } catch (error) {
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
  if (value.length < 32 || value.length > 512 || /\s|[\u0000-\u001f\u007f]/u.test(value)) {
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
  headers.delete('connection');
  headers.delete('keep-alive');
  headers.delete('transfer-encoding');
  return new Response(source.body, { status: source.status, statusText: source.statusText, headers });
}
