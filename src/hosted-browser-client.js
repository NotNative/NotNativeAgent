// SPDX-License-Identifier: Apache-2.0
/**
 * The client half of driving the OpenChamber browser pane.
 *
 * Why this exists: the pane is the only place a page is rendered, and it is
 * driven through OpenChamber's own router, so NNA asks OpenChamber to run an
 * action rather than rendering anything itself. Everything the pane enforces —
 * the claim race, tab scoping by session, the display-only distinction, the
 * provider switch, every snapshot bound — then applies unchanged, which is what
 * makes this the same browser the operator is looking at.
 *
 * Invariant: the binding is per-instance and dies with the instance. It arrives
 * through this process's environment when NNA launched OpenChamber, and
 * otherwise through the capability file OpenChamber writes beside its own
 * instance state. It is never read from a user or machine registry scope: a
 * binding that outlived its server would point at a dead port.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';

const ROUTE = '/api/openchamber/nna/browser';
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;
const REQUEST_BYTES = 65_536;
const REPLY_BYTES = 12_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 45_000;
/** Actions OpenChamber's pane accepts, in its own spelling. */
const ACTIONS = Object.freeze(['browser.open', 'browser.snapshot', 'browser.inspect',
  'browser.click', 'browser.type', 'browser.select', 'browser.scroll', 'browser.back',
  'browser.forward', 'browser.capture', 'browser.resize', 'browser.close']);

export const HOSTED_BROWSER_ACTIONS = ACTIONS;
export const HOSTED_BROWSER_ROUTE = ROUTE;

const unavailable = (message, code = 'hosted_browser_unavailable', cause) => new ContractError(code, message,
  cause === undefined ? undefined : { cause });

/**
 * A binding is usable only when it names this machine on the pane's own route.
 * Why loopback-only: the pane is a local surface that runs pages with the
 * operator's live logins, so a binding that pointed anywhere else would hand
 * that session to a remote process.
 */
export function hostedBrowserBindingFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { url, token } = value;
  if (typeof url !== 'string' || typeof token !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
    || Number(parsed.port) < 1 || Number(parsed.port) > 65_535
    || parsed.pathname !== ROUTE || parsed.search || parsed.hash || parsed.username || parsed.password
    || !TOKEN.test(token)) return null;
  return Object.freeze({ url: parsed.href, token });
}

/** Why both sources: a launcher that hands the binding down needs no file, and a
 *  separately started OpenChamber needs no launcher; either alone is enough. */
export function hostedBrowserBindingFromEnvironment(environment = {}) {
  const url = environment.NNA_OPENCHAMBER_BROWSER_URL;
  const token = environment.NNA_OPENCHAMBER_BROWSER_TOKEN;
  if (url === undefined && token === undefined) return null;
  const binding = hostedBrowserBindingFrom({ url, token });
  if (!binding) throw unavailable('the OpenChamber browser binding in this environment is invalid', 'hosted_browser_binding_invalid');
  return binding;
}

/**
 * Reads the capability file OpenChamber publishes when it starts. A missing or
 * unreadable file means the pane is not available here, which is an ordinary
 * state rather than an error: the operator may not run OpenChamber at all.
 */
export async function readHostedBrowserBinding(path, { read = readFile } = {}) {
  if (typeof path !== 'string' || path.length === 0) return null;
  let text;
  try { text = await read(path, 'utf8'); } catch { return null; }
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return hostedBrowserBindingFrom(value);
}

/** Resolves the binding once, environment first, then the capability file. */
export async function resolveHostedBrowserBinding({ environment = process.env, capabilityPath = null, read } = {}) {
  const fromEnvironment = hostedBrowserBindingFromEnvironment(environment);
  if (fromEnvironment) return fromEnvironment;
  return readHostedBrowserBinding(capabilityPath, read === undefined ? {} : { read });
}

/**
 * The OpenChamber instance's own capability file, beside the state it keeps for
 * itself. Why there: the binding is per-instance, so it lives where that
 * instance already writes, and it dies with the directory it wrote.
 */
export function hostedBrowserCapabilityPath(dataRoot) {
  return typeof dataRoot === 'string' && dataRoot.length > 0 ? join(dataRoot, 'nna-browser.json') : null;
}

/**
 * Builds the transport a served conversation drives, or null when this host has
 * no pane to drive.
 *
 * Why null rather than an error: an operator may run NNA's surface without
 * OpenChamber at all, and a conversation with no page to show must get no
 * browser tool instead of one whose every call fails.
 */
export async function openHostedBrowserTransport({ environment = process.env, dataRoot = null, ...rest } = {}) {
  const binding = await resolveHostedBrowserBinding({
    environment, capabilityPath: hostedBrowserCapabilityPath(dataRoot), ...rest,
  }).catch(() => null);
  return binding ? createHostedBrowserTransport(binding, rest) : null;
}

function boundedBody(value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > REQUEST_BYTES) {
    throw unavailable('the browser action was too large to send', 'hosted_browser_request_large');
  }
  return body;
}

/** One graded request, or the reason the pane could not be reached. */
async function postToPane(binding, fetcher, action, body, signal) {
  const timeoutMs = action === 'browser.open' ? OPEN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  try {
    return await fetcher(binding.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${binding.token}` },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw new ContractError('tool_cancelled', 'browser action was cancelled', { cause: error });
    // Why not 'failed': a timeout or a refused connection leaves the outcome
    // unknown for anything that changes a page, and the caller says so.
    throw unavailable('OpenChamber did not answer the browser action', 'hosted_browser_unreachable', error);
  }
}

/**
 * Reads one reply under its bound, or says why it could not be read. A snapshot
 * legitimately carries the visible text plus every interactive element, so the
 * bound is the size of a real snapshot and never unbounded.
 */
async function readPaneReply(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > REPLY_BYTES) {
    throw unavailable('the browser reply exceeded its bound', 'hosted_browser_reply_large');
  }
  let text;
  try { text = await response.text(); } catch (error) {
    throw unavailable('the browser reply could not be read', 'hosted_browser_reply_invalid', error);
  }
  if (Buffer.byteLength(text) > REPLY_BYTES) {
    throw unavailable('the browser reply exceeded its bound', 'hosted_browser_reply_large');
  }
  let result;
  try { result = JSON.parse(text); } catch {
    throw unavailable(`OpenChamber answered HTTP ${response.status} without a browser result`, 'hosted_browser_reply_invalid');
  }
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw unavailable('OpenChamber answered without a browser result', 'hosted_browser_reply_invalid');
  }
  if (result.ok !== true) {
    // Read by the model: it says what to do differently, not what broke.
    throw unavailable(typeof result.error === 'string' && result.error ? result.error.slice(0, 500) : 'the browser action failed',
      'hosted_browser_failed');
  }
  return result.data ?? null;
}

/** Builds the transport a conversation uses to drive the OpenChamber pane. */
export function createHostedBrowserTransport(binding, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const createId = options.createId ?? (() => `nba-${crypto.randomUUID()}`);
  if (!binding || typeof binding.url !== 'string' || typeof binding.token !== 'string') {
    throw unavailable('the OpenChamber browser binding is invalid', 'hosted_browser_binding_invalid');
  }
  return {
    name: 'openchamber-pane',
    /** @param {string} action @param {object} parameters @param {{signal?: AbortSignal, context?: object}} options */
    async send(action, parameters, { signal, context } = {}) {
      if (!ACTIONS.includes(action)) throw unavailable(`OpenChamber does not accept ${action}`, 'hosted_browser_action_unsupported');
      if (signal?.aborted) throw new ContractError('tool_cancelled', 'browser action was cancelled');
      // Why outside postToPane(): an oversized body is our own refusal, and
      // reporting it as an unreachable pane would send the model hunting a fault.
      const body = boundedBody({ requestId: createId(), action, parameters,
        context: { directory: context?.directory ?? null, sessionId: context?.sessionId ?? null } });
      const response = await postToPane(binding, fetcher, action, body, signal);
      if (response.status === 401) {
        throw unavailable('OpenChamber did not accept this browser credential; it may have restarted',
          'hosted_browser_unauthorized');
      }
      return readPaneReply(response);
    },
  };
}
