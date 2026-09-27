// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;
const CALLBACK_PATH = '/api/browser-control/request';
const MAX_REPLY_BYTES = 262_144;
const MAX_CAPTURES_PER_SESSION = 256;

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
  let observedRevision = null;
  let observedId = null;
  let observationRevision = 0;
  return {
    name: 'nnd_browser', version: 1,
    purpose: 'Control the connected NND desktop browser: open, snapshot, inspect, click, scroll, history, type, or capture the exact observed page. Requires a connected desktop.',
    sideEffect: 'unknown', scope: 'browser', cancellation: true, timeoutMs: 55_000, maxOutputBytes: MAX_REPLY_BYTES,
    inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['open', 'snapshot', 'inspect', 'click', 'scroll', 'history', 'type', 'capture'], description: 'Open, observe, inspect, click, scroll, navigate preview history, type into one field, or capture the viewport.' },
      url: { type: 'string', maxLength: 2048, description: 'Required for open only: HTTPS or numeric-loopback HTTP URL.' },
      selector: { type: 'string', maxLength: 500, description: 'Required for inspect, click, or type: CSS selector from the page.' },
      expectedUrl: { type: 'string', maxLength: 2048, description: 'Required for click, scroll, history, type, or capture: exact URL from the latest page snapshot.' },
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom', 'back', 'forward'], description: 'Required for scroll (viewport) or history (preview back/forward).' },
      text: { type: 'string', maxLength: 2000, description: 'Required for type: replacement text for one ordinary field. Never use for passwords or secrets.' },
    } },
    validate: async (args) => validateNndBrowserArgs(args),
    executor: async (request, signal) => {
      const action = request.args.action;
      if (['click', 'scroll', 'history', 'type', 'capture'].includes(action)
        && (observedUrl !== request.args.expectedUrl || observedRevision === null || observedId === null))
        throw invalid(`${action} requires a fresh snapshot of the exact page URL`);
      const authorizedRevision = observedRevision;
      const authorizedId = observedId;
      if (['open', 'snapshot', 'click', 'scroll', 'history', 'type', 'capture'].includes(action)) {
        observedUrl = null;
        observedRevision = null;
        observedId = null;
        observationRevision += 1;
      }
      const revision = observationRevision;
      const result = await executeNndBrowser(callback, fetcher, request, signal, authorizedRevision, authorizedId);
      if (action === 'snapshot') {
        let data;
        try { data = JSON.parse(result.content); } catch { /* validated below */ }
        if (!data || typeof data.url !== 'string' || data.url.length > 2048 || !safeObservedUrl(data.url)
          || !Number.isSafeInteger(data.observationRevision) || data.observationRevision < 0
          || typeof data.observationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(data.observationId))
          throw new ContractError('nnd_browser_reply_invalid', 'NND browser snapshot had no safe observation');
        if (revision === observationRevision) {
          observedUrl = data.url;
          observedRevision = data.observationRevision;
          observedId = data.observationId;
        }
        const { observationRevision: _privateRevision, observationId: _privateId, ...publicSnapshot } = data;
        return { ...result, content: JSON.stringify(publicSnapshot) };
      }
      if (action === 'capture') return persistNndCapture(result, request.args.expectedUrl, options.captureRoot, signal);
      return result;
    },
  };
}

function validateNndBrowserArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !['open', 'snapshot', 'inspect', 'click', 'scroll', 'history', 'type', 'capture'].includes(args.action)
    || Object.keys(args).some((key) => !['action', 'url', 'selector', 'expectedUrl', 'direction', 'text'].includes(key))) throw invalid('NND browser arguments are invalid');
  if (args.action === 'open') {
    if (typeof args.url !== 'string' || args.url.length > 2048 || !safePageUrl(args.url)
      || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'expectedUrl') || Object.hasOwn(args, 'direction')
      || Object.hasOwn(args, 'text')) throw invalid('NND browser URL is unsafe');
  } else if (['inspect', 'click', 'type'].includes(args.action)) {
    if (Object.hasOwn(args, 'url') || typeof args.selector !== 'string' || !args.selector || args.selector.length > 500
      || Object.hasOwn(args, 'direction') || (args.action === 'inspect' && Object.hasOwn(args, 'expectedUrl'))
      || (args.action !== 'type' && Object.hasOwn(args, 'text')))
      throw invalid(`${args.action} requires one bounded CSS selector`);
    if (args.action !== 'inspect' && (typeof args.expectedUrl !== 'string' || args.expectedUrl.length > 2048
      || !safeObservedUrl(args.expectedUrl))) throw invalid(`${args.action} requires an observed safe page URL`);
    if (args.action === 'type' && (typeof args.text !== 'string' || args.text.length > 2000))
      throw invalid('type requires bounded text');
  } else if (args.action === 'scroll') {
    if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'text')
      || !['up', 'down', 'top', 'bottom'].includes(args.direction)
      || typeof args.expectedUrl !== 'string' || args.expectedUrl.length > 2048 || !safeObservedUrl(args.expectedUrl))
      throw invalid('scroll requires a direction and observed safe page URL');
  } else if (args.action === 'history') {
    if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'text')
      || !['back', 'forward'].includes(args.direction)
      || typeof args.expectedUrl !== 'string' || args.expectedUrl.length > 2048 || !safeObservedUrl(args.expectedUrl))
      throw invalid('history requires back or forward and an observed safe page URL');
  } else if (args.action === 'capture') {
    if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'text')
      || Object.hasOwn(args, 'direction') || typeof args.expectedUrl !== 'string'
      || args.expectedUrl.length > 2048 || !safeObservedUrl(args.expectedUrl))
      throw invalid('capture requires an observed safe page URL');
  } else if (Object.hasOwn(args, 'url') || Object.hasOwn(args, 'selector') || Object.hasOwn(args, 'expectedUrl')
    || Object.hasOwn(args, 'direction') || Object.hasOwn(args, 'text'))
    throw invalid('snapshot takes no parameters');
  return { args: args.action === 'open' ? { action: 'open', url: args.url }
    : args.action === 'inspect' ? { action: 'inspect', selector: args.selector }
      : args.action === 'click' ? { action: 'click', selector: args.selector, expectedUrl: args.expectedUrl }
        : ['scroll', 'history'].includes(args.action) ? { action: args.action, direction: args.direction, expectedUrl: args.expectedUrl }
          : args.action === 'type' ? { action: 'type', selector: args.selector, expectedUrl: args.expectedUrl, text: args.text }
            : args.action === 'capture' ? { action: 'capture', expectedUrl: args.expectedUrl }
          : { action: 'snapshot' },
    resolved: { surface: 'nnd-desktop-browser' } };
}

async function executeNndBrowser(callback, fetcher, request, signal, observedRevision, observedId) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'browser request was cancelled');
  let response;
  try {
    response = await fetcher(callback.url, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-nnd-browser-token': callback.token,
    }, body: JSON.stringify({ action: `browser.${request.args.action}`,
      parameters: request.args.action === 'open' ? { url: request.args.url }
        : request.args.action === 'inspect' ? { selector: request.args.selector }
          : request.args.action === 'click' ? { selector: request.args.selector, expectedUrl: request.args.expectedUrl, observationRevision: observedRevision, observationId: observedId }
            : ['scroll', 'history'].includes(request.args.action) ? { direction: request.args.direction, expectedUrl: request.args.expectedUrl, observationRevision: observedRevision, observationId: observedId }
              : request.args.action === 'type' ? { selector: request.args.selector, expectedUrl: request.args.expectedUrl, text: request.args.text, observationRevision: observedRevision, observationId: observedId }
                : request.args.action === 'capture' ? { expectedUrl: request.args.expectedUrl, observationRevision: observedRevision, observationId: observedId }
            : {} }), signal });
  } catch (error) {
    if (signal.aborted) throw new ContractError('tool_cancelled', 'browser request was cancelled', { cause: error });
    throw new ContractError('nnd_browser_unavailable', 'NND desktop browser callback is unavailable', { cause: error });
  }
  if (!response.ok) throw new ContractError('nnd_browser_failed', ['click', 'scroll', 'history', 'type', 'capture'].includes(request.args.action)
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

async function persistNndCapture(result, expectedUrl, captureRoot, signal) {
  if (typeof captureRoot !== 'string' || !captureRoot) throw new ContractError('nnd_browser_unavailable', 'NND capture storage is unavailable');
  let capture;
  try { capture = JSON.parse(result.content); }
  catch { throw new ContractError('nnd_browser_reply_invalid', 'NND capture reply was invalid'); }
  if (!capture || capture.url !== expectedUrl || capture.mime !== 'image/jpeg'
    || !Number.isSafeInteger(capture.width) || capture.width < 1 || capture.width > 1600
    || !Number.isSafeInteger(capture.height) || capture.height < 1 || capture.height > 1200
    || typeof capture.base64 !== 'string' || capture.base64.length > 200_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(capture.base64))
    throw new ContractError('nnd_browser_reply_invalid', 'NND capture reply was invalid');
  const bytes = Buffer.from(capture.base64, 'base64');
  if (bytes.length < 4 || bytes.length > 150_000 || bytes.toString('base64') !== capture.base64
    || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
    throw new ContractError('nnd_browser_reply_invalid', 'NND capture image was invalid');
  if (signal.aborted) throw new ContractError('tool_cancelled', 'browser capture was cancelled');
  await mkdir(captureRoot, { recursive: true, mode: 0o700 });
  const priorCaptures = (await readdir(captureRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^capture-[0-9a-f-]{36}\.jpg$/u.test(entry.name)).length;
  if (priorCaptures >= MAX_CAPTURES_PER_SESSION)
    throw new ContractError('nnd_browser_capture_limit', 'This session reached its 256-capture limit; remove old captures before taking another screenshot');
  const path = join(captureRoot, `capture-${randomUUID()}.jpg`);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(bytes, { signal });
    await handle.close();
    handle = null;
    if (signal.aborted) throw new ContractError('tool_cancelled', 'browser capture was cancelled');
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { content: `Screenshot saved: ${path}\n\nUse image_inspect with this exact path when visual interpretation is needed.`,
    metadata: { ...result.metadata, path, mimeType: 'image/jpeg', width: capture.width, height: capture.height } };
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
