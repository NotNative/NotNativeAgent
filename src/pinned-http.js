// SPDX-License-Identifier: Apache-2.0
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ContractError } from './ids.js';

export function pinnedHttpRequest(url, address, options = {}) {
  if (!options.signal || typeof options.signal.addEventListener !== 'function') {
    throw new ContractError('pinned_http_signal_required', 'pinned HTTP requests require an abort signal');
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol, hostname: address, port: url.port || undefined,
      method: options.method ?? 'GET', path: `${url.pathname}${url.search}`,
      servername: url.hostname, headers: { ...options.headers, host: url.host },
    }, (response) => {
      const cleanup = () => options.signal.removeEventListener('abort', abort);
      response.once('end', cleanup);
      response.once('close', cleanup);
      // Keep an unconsumed response failure from becoming an uncaught EventEmitter error;
      // consumers using events or async iteration still receive the same error themselves.
      response.on('error', () => undefined);
      resolve(responseView(response));
    });
    const abort = () => request.destroy(options.signal.reason ?? new Error('aborted'));
    if (options.signal.aborted) abort();
    else options.signal.addEventListener('abort', abort, { once: true });
    request.once('error', reject);
    request.once('close', () => options.signal.removeEventListener('abort', abort));
    request.end();
  });
}

function responseView(response) {
  const status = response.statusCode ?? 0;
  return Object.freeze({
    status, ok: status >= 200 && status < 300, body: response,
    headers: Object.freeze({ get: (name) => headerValue(response.headers[name.toLowerCase()]) }),
  });
}

function headerValue(value) {
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? null : String(value);
}
