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
  // This definition belongs to one engine session. A click consumes the latest
  // successful observation before dispatch, so an uncertain outcome cannot be
  // repeated using the same evidence.
  let observedUrl = null;
  let observationRevision = 0;
  return {
    name: 'nnd_browser', version: 1,
    purpose: 'Control the connected NND desktop browser: open, snapshot, inspect, click, or scroll the exact observed page. Requires a connected desktop.',
    sideEffect: 'unknown', scope: 'browser', cancellation: true, timeoutMs: 55_000, maxOutputBytes: MAX_REPLY_BYTES,
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['open', 'snapshot', 'inspect', 'click', 'scroll'], description: 'Open a URL, observe the page, inspect one element, click a visible element, or scroll the viewport.' },
      url: { type: 'string', maxLength: 2048, description: 'Required for open only: HTTPS or numeric-loopback HTTP URL.' },
      selector: { type: 'string', maxLength: 500, description: 'Required for inspect or click: CSS selector from the page.' },
      expectedUrl: { type: 'string', maxLength: 2048, description: 'Required for click or scroll: exact URL from the latest page snapshot.' },
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Required for scroll: viewport direction.' },
    } },
    validate: async (args) => validateNndBrowserArgs(args),
    executor: async (request, signal) => {
      const action = request.args.action;
      if ((action === 'click' || action === 'scroll') && observedUrl !== request.args.expectedUrl)
        throw invalid(`${action} requires a fresh snapshot of the exact page URL`);
      if (action === 'open' || action === 'snapshot' || action === 'click' || action === 'scroll') {
        observedUrl = null;
        observationRevision += 1;
      }
      const revision = observationRevision;
      const result = await executeNndBrowser(callback, fetcher, request, signal);
      if (action === 'snapshot') {
        let data;
        try { data = JSON.parse(result.content); } catch { /* validated below */ }
        if (!data || typeof data.url !== 'string' || data.url.length > 2048 || !safeObservedUrl(data.url))
          throw new ContractError('nnd_browser_reply_invalid', 'NND browser snapshot had no safe observed URL');
        if (revision === observationRevision) observedUrl = data.url;
      }
      return result;
    },
  };
}

function validateNndBrowserArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !['open', 'snapshot', 'inspect', 'click', 'scroll'].includes(args.action)
    || Object.keys(args).some((key) => !['action', 'url', 'selector', 'expectedUrl', 'direction'].includes(key))) throw invalid('NND browser arguments are invalid');
  if (args.action === 'open') {
    if (typeof args.url !== 'string' || args.url.length > 2048 || !safePageUrl(args.url)
      || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'expectedUrl') || Object.hasOwn(args, 'direction')) throw invalid('NND browser URL is unsafe');
  } else if (args.action === 'inspect' || args.action === 'click') {
    if (Object.hasOwn(args, 'url') || typeof args.selector !== 'string' || !args.selector || args.selector.length > 500
      || Object.hasOwn(args, 'direction') || (args.action === 'inspect' && Object.hasOwn(args, 'expectedUrl')))
      throw invalid(`${args.action} requires one bounded CSS selector`);
    if (args.action === 'click' && (typeof args.expectedUrl !== 'string' || args.expectedUrl.length > 2048
      || !safeObservedUrl(args.expectedUrl))) throw invalid('click requires an observed safe page URL');
  } else if (args.action === 'scroll') {
    if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector')
      || !['up', 'down', 'top', 'bottom'].includes(args.direction)
      || typeof args.expectedUrl !== 'string' || args.expectedUrl.length > 2048 || !safeObservedUrl(args.expectedUrl))
      throw invalid('scroll requires a direction and observed safe page URL');
  } else if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'expectedUrl')
    || Object.hasOwn(args, 'direction'))
    throw invalid('snapshot takes no parameters');
  return { args: args.action === 'open' ? { action: 'open', url: args.url }
    : args.action === 'inspect' ? { action: 'inspect', selector: args.selector }
      : args.action === 'click' ? { action: 'click', selector: args.selector, expectedUrl: args.expectedUrl }
        : args.action === 'scroll' ? { action: 'scroll', direction: args.direction, expectedUrl: args.expectedUrl }
          : { action: 'snapshot' },
    resolved: { surface: 'nnd-desktop-browser' } };
}

async function executeNndBrowser(callback, fetcher, request, signal) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'browser request was cancelled');
  let response;
  try {
    response = await fetcher(callback.url, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-nnd-browser-token': callback.token,
    }, body: JSON.stringify({ action: `browser.${request.args.action}`,
      parameters: request.args.action === 'open' ? { url: request.args.url }
        : request.args.action === 'inspect' ? { selector: request.args.selector }
          : request.args.action === 'click' ? { selector: request.args.selector, expectedUrl: request.args.expectedUrl }
            : request.args.action === 'scroll' ? { direction: request.args.direction, expectedUrl: request.args.expectedUrl }
            : {} }), signal });
  } catch (error) {
    if (signal.aborted) throw new ContractError('tool_cancelled', 'browser request was cancelled', { cause: error });
    throw new ContractError('nnd_browser_unavailable', 'NND desktop browser callback is unavailable', { cause: error });
  }
  if (!response.ok) throw new ContractError('nnd_browser_failed', ['click', 'scroll'].includes(request.args.action)
    ? `${request.args.action} outcome is uncertain (${response.status}); snapshot the page before retrying`
    : response.status === 503 ? 'No connected desktop browser can perform this action'
      : `NND browser action failed (${response.status})`);
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

function safeObservedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return !url.username && !url.password && (url.protocol === 'https:'
    || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
}

function invalid(message) { return new ContractError('tool_schema_invalid', message); }
