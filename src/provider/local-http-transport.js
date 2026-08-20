// SPDX-License-Identifier: Apache-2.0
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';
import { ContractError } from '../ids.js';

// Node's Fetch implementation inherits an HTTP body-idle timeout from Undici.
// Local inference servers may legitimately buffer minutes of private reasoning
// without emitting an SSE body chunk, so trusted local routes use the native
// HTTP stack and leave deadline ownership with ProviderRunner.
export function localProviderFetch(input, init = {}, options = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ContractError('provider_endpoint_invalid', 'local provider endpoint is invalid');
  }
  const request = options.request
    ?? (url.protocol === 'https:' ? requestHttps : requestHttp);
  const body = requestBody(init.body);
  const headers = requestHeaders(init.headers);
  return new Promise((resolve, reject) => {
    let settled = false;
    const outgoing = request(url, {
      method: init.method ?? 'GET', headers, signal: init.signal,
    }, (incoming) => {
      settled = true;
      const status = incoming.statusCode ?? 502;
      const responseBody = responseMayHaveBody(init.method, status) ? Readable.toWeb(incoming) : null;
      resolve(new Response(responseBody, {
        status, statusText: incoming.statusMessage ?? '', headers: responseHeaders(incoming.headers),
      }));
    });
    outgoing.once('error', (error) => { if (!settled) reject(error); });
    outgoing.end(body);
  });
}

function requestBody(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  throw new ContractError('provider_request_body_invalid', 'provider request body is unsupported');
}

function requestHeaders(value) {
  const result = {};
  for (const [name, content] of new Headers(value ?? {}).entries()) result[name] = content;
  if (result['accept-encoding'] === undefined) result['accept-encoding'] = 'identity';
  return result;
}

function responseHeaders(value) {
  const result = new Headers();
  for (const [name, content] of Object.entries(value)) {
    if (Array.isArray(content)) for (const item of content) result.append(name, item);
    else if (content !== undefined) result.set(name, content);
  }
  return result;
}

function responseMayHaveBody(method, status) {
  return method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
}
