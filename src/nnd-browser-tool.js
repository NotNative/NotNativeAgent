// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;
const CALLBACK_PATH = '/api/browser-control/request';
const MAX_REPLY_BYTES = 262_144;

/** A capability exists only in the NND-owned child, never in standalone NNA. */
export function nndBrowserCallbackFromEnvironment(environment) {
  const rawUrl = environment.NNA_NND_BROWSER_URL;
  const token = environment.NNA_NND_BROWSER_TOKEN;
  if (rawUrl === undefined && token === undefined) return null;
  let url;
  try { url = new URL(rawUrl); } catch { throw invalid('NND browser callback URL is invalid'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) > 65535
    || url.pathname !== CALLBACK_PATH || url.search || url.hash || url.username || url.password
    || typeof token !== 'string' || !TOKEN.test(token)) throw invalid('NND browser callback is invalid');
  return Object.freeze({ url: url.href, token });
}

/** The launch secret must not remain in the long-lived NNA process environment.
 * In particular, later optional subprocesses may inherit process.env. Test or
 * embedded callers supplying their own environment retain ownership of it. */
export function consumeNndBrowserCallbackFromEnvironment(environment) {
  try { return nndBrowserCallbackFromEnvironment(environment); }
  finally {
    if (environment === process.env) {
      delete process.env.NNA_NND_BROWSER_URL;
      delete process.env.NNA_NND_BROWSER_TOKEN;
    }
  }
}

export function nndBrowserDefinition(callback, options = {}) {
  if (!callback || typeof callback.url !== 'string' || typeof callback.token !== 'string') throw invalid('NND browser callback is invalid');
  const fetcher = options.fetcher ?? fetch;
  return {
    name: 'nnd_browser', version: 1,
    purpose: 'Control the connected NND desktop browser: open an HTTPS or loopback page, read a bounded page snapshot, or inspect computed styles for one CSS selector. Requires a connected desktop.',
    sideEffect: 'unknown', scope: 'browser', cancellation: true, timeoutMs: 55_000, maxOutputBytes: MAX_REPLY_BYTES,
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['open', 'snapshot', 'inspect'], description: 'Open a URL, observe the page, or inspect one element.' },
      url: { type: 'string', maxLength: 2048, description: 'Required for open only: HTTPS or numeric-loopback HTTP URL.' },
      selector: { type: 'string', maxLength: 500, description: 'Required for inspect only: CSS selector from a snapshot or the page.' },
    } },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args) || !['open', 'snapshot', 'inspect'].includes(args.action)
        || Object.keys(args).some((key) => !['action', 'url', 'selector'].includes(key))) throw invalid('NND browser arguments are invalid');
      if (args.action === 'open') {
        if (typeof args.url !== 'string' || args.url.length > 2048 || !safePageUrl(args.url) || Object.hasOwn(args, 'selector')) throw invalid('NND browser URL is unsafe');
      } else if (args.action === 'inspect') {
        if (Object.hasOwn(args, 'url') || typeof args.selector !== 'string' || !args.selector || args.selector.length > 500)
          throw invalid('inspect requires one bounded CSS selector');
      } else if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector')) throw invalid('snapshot takes no parameters');
      return { args: args.action === 'open' ? { action: 'open', url: args.url }
        : args.action === 'inspect' ? { action: 'inspect', selector: args.selector } : { action: 'snapshot' },
        resolved: { surface: 'nnd-desktop-browser' } };
    },
    executor: (request, signal) => executeNndBrowser(callback, fetcher, request, signal),
  };
}

async function executeNndBrowser(callback, fetcher, request, signal) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'browser request was cancelled');
  let response;
  try {
    response = await fetcher(callback.url, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-nnd-browser-token': callback.token,
    }, body: JSON.stringify({ action: `browser.${request.args.action}`,
      parameters: request.args.action === 'open' ? { url: request.args.url }
        : request.args.action === 'inspect' ? { selector: request.args.selector } : {} }), signal });
  } catch (error) {
    if (signal.aborted) throw new ContractError('tool_cancelled', 'browser request was cancelled', { cause: error });
    throw new ContractError('nnd_browser_unavailable', 'NND desktop browser callback is unavailable', { cause: error });
  }
  if (!response.ok) throw new ContractError('nnd_browser_failed',
    response.status === 503 ? 'No connected desktop browser can perform this action' : `NND browser action failed (${response.status})`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REPLY_BYTES) throw new ContractError('nnd_browser_reply_large', 'NND browser reply exceeded its bound');
  const reader = response.body?.getReader();
  if (!reader) throw new ContractError('nnd_browser_reply_invalid', 'NND browser reply was empty');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY_BYTES) throw new ContractError('nnd_browser_reply_large', 'NND browser reply exceeded its bound');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ContractError('nnd_browser_reply_invalid', 'NND browser reply was invalid'); }
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
    throw new ContractError('nnd_browser_reply_invalid', 'NND browser reply was invalid');
  if (!result.ok) throw new ContractError('nnd_browser_failed',
    typeof result.error === 'string' ? result.error.slice(0, 500) : 'NND browser action failed');
  return { content: JSON.stringify(result.data), metadata: { action: request.args.action, surface: 'nnd-desktop-browser' } };
}

function safePageUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return !url.username && !url.password && !url.hash &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)));
}

function invalid(message) { return new ContractError('tool_schema_invalid', message); }
