// SPDX-License-Identifier: Apache-2.0
/**
 * The client half of driving the OpenChamber browser pane.
 *
 * Why this route: OpenChamber already exposes one loopback endpoint that runs a
 * control action — `POST /api/openchamber/control` — and the browser actions are
 * on it beside the session and schedule families. Using it means the pane is
 * driven through OpenChamber's own router, exactly as its built-in agent tool
 * drives it, so the in-app view stays the only executor and the claim race, tab
 * scoping by session, display-only distinction, provider switch and every
 * snapshot bound apply unchanged. Nothing has to be added to the running app.
 *
 * Invariant: the binding is per-instance and dies with the instance. It arrives
 * through this process's environment when NNA launched OpenChamber, and otherwise
 * from the instance state OpenChamber publishes. It is never read from a user or
 * machine registry scope: a binding that outlived its server would point at a
 * dead port.
 */
import { readFile, readdir as readDirectory } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';

const ROUTE = '/api/openchamber/control';
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;
const REQUEST_BYTES = 65_536;
const REPLY_BYTES = 12_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 45_000;
/** Actions the pane answers, in OpenChamber's own spelling. */
const ACTIONS = Object.freeze(['browser.open', 'browser.snapshot', 'browser.inspect',
  'browser.click', 'browser.type', 'browser.select', 'browser.scroll', 'browser.back',
  'browser.forward', 'browser.capture', 'browser.resize', 'browser.close']);

export const HOSTED_BROWSER_ACTIONS = ACTIONS;
export const HOSTED_BROWSER_ROUTE = ROUTE;

const unavailable = (message, code = 'hosted_browser_unavailable', cause) => new ContractError(code, message,
  cause === undefined ? undefined : { cause });

/**
 * A binding is usable only when it names this machine on the control route.
 * Why loopback-only: the pane is a local surface that runs pages with the
 * operator's live logins, so a binding that pointed anywhere else would hand
 * that session to a remote process.
 */
export function hostedBrowserBindingFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { url, token } = value;
  if (typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
    || Number(parsed.port) < 1 || Number(parsed.port) > 65_535
    || parsed.pathname !== ROUTE || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  // The control route needs no credential on a local install; a caller that was
  // given one keeps it, so the same binding shape works either way.
  if (token === undefined) return Object.freeze({ url: parsed.href, token: null });
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
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
 * Reads a capability file. A missing or unreadable file means no pane is
 * published there, which is an ordinary state rather than an error: the operator
 * may not run OpenChamber at all.
 */
export async function readHostedBrowserBinding(path, { read = readFile } = {}) {
  if (typeof path !== 'string' || path.length === 0) return null;
  let text;
  try { text = await read(path, 'utf8'); } catch { return null; }
  try { return hostedBrowserBindingFrom(JSON.parse(text)); } catch { return null; }
}

/** Resolves the binding once, environment first, then a named capability file. */
export async function resolveHostedBrowserBinding({ environment = process.env, capabilityPath = null, read } = {}) {
  const fromEnvironment = hostedBrowserBindingFromEnvironment(environment);
  if (fromEnvironment) return fromEnvironment;
  return readHostedBrowserBinding(capabilityPath, read === undefined ? {} : { read });
}

/**
 * Where OpenChamber keeps instance state.
 *
 * Why these roots: OpenChamber derives its data root from `OPENCHAMBER_DATA_DIR`
 * or `~/.config/openchamber`, with the Windows desktop profile as the other place
 * a build may keep it. NNA's own data root is unrelated — the products keep
 * separate data — so the roots must come from OpenChamber's own convention.
 */
export function hostedBrowserStateRoots(environment = process.env, home = homedir()) {
  const roots = [];
  const configured = typeof environment.OPENCHAMBER_DATA_DIR === 'string' ? environment.OPENCHAMBER_DATA_DIR.trim() : '';
  if (configured) roots.push(resolve(configured));
  roots.push(join(home, '.config', 'openchamber'));
  if (typeof environment.APPDATA === 'string' && environment.APPDATA) roots.push(join(environment.APPDATA, 'OpenChamber'));
  return [...new Set(roots)];
}

const CAPABILITY_FILE = 'nna-browser.json';

/** The instance directories under one data root, newest first. */
async function instanceDirs(root, readdir) {
  const base = join(root, 'run', 'instances');
  let entries;
  try { entries = await readdir(base, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => join(base, entry.name)).reverse();
}

/** A published capability file, across every root and instance. */
export async function findHostedBrowserBinding({ environment = process.env, home = homedir(), readdir = readDirectory } = {}) {
  for (const root of hostedBrowserStateRoots(environment, home)) {
    for (const directory of await instanceDirs(root, readdir)) {
      const binding = await readHostedBrowserBinding(join(directory, CAPABILITY_FILE));
      if (binding) return binding;
    }
  }
  return null;
}

/**
 * Files OpenChamber rewrites on every start that carry its own origin.
 *
 * Why this is the primary source: a desktop install binds an ephemeral port and
 * publishes it nowhere obvious, but it does write these on each launch — the git
 * credential helper endpoint names the listener, and the instance marker records
 * the port beside it. Reading them is exact, where probing a guessed list is not:
 * a live instance on 57123 was invisible to a probe of 3000/3001/5173/4096, so the
 * model was handed NNA's own Playwright browser instead of the pane in front of it.
 */
const ORIGIN_SOURCES = Object.freeze([
  { file: 'git-credential-endpoint.json', pick: (value) => value?.url },
  { file: 'run/openchamber-3000.json', pick: (value) => (value?.port ? `http://127.0.0.1:${value.port}/` : null) },
]);

/** The origin one JSON file names, or null when it names none. */
async function originFromFile(root, source, read) {
  let text;
  try { text = await read(join(root, source.file), 'utf8'); } catch { return null; }
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  const named = source.pick(value);
  if (typeof named !== 'string') return null;
  let parsed;
  try { parsed = new URL(named); } catch { return null; }
  // Only a loopback origin is usable, for the same reason a binding must be.
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) return null;
  return `http://127.0.0.1:${parsed.port}`;
}

/**
 * The origin of a running OpenChamber, found in the files it writes.
 *
 * Why several roots and files: a user may relocate the data root, and a daemon
 * and a desktop install record their port in different places. Any one of them
 * naming a loopback origin is enough; the caller then verifies it answers.
 */
export async function findHostedBrowserOrigin({ environment = process.env, home = homedir(), read = readFile } = {}) {
  for (const root of hostedBrowserStateRoots(environment, home)) {
    for (const source of ORIGIN_SOURCES) {
      const origin = await originFromFile(root, source, read);
      if (origin) return origin;
    }
  }
  return null;
}

/**
 * Probes a candidate port for a live control route.
 *
 * Why a probe: a running OpenChamber does not publish its port where NNA can read
 * it, and the health answer names the surface. This is the fallback that makes the
 * feature work against whatever instance is actually listening.
 */
export async function probeHostedBrowser({ ports = [], fetcher = fetch } = {}) {
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) continue;
    const url = `http://127.0.0.1:${port}${ROUTE}`;
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'models.list', input: {} }),
        signal: AbortSignal.timeout(2_500),
      });
      // Any JSON answer means a control route is serving this port.
      if (response.ok) return Object.freeze({ url, token: null });
    } catch { /* not this port */ }
  }
  return null;
}

/**
 * Whether an origin actually answers the control route.
 *
 * Why verify: an origin read from a file describes the last process that wrote
 * it, which may have exited. Trusting it would install a browser tool whose every
 * call fails, so a discovered origin is treated as a candidate until it answers.
 */
export async function originAnswers({ origin, fetcher = fetch, timeoutMs = 2_500 } = {}) {
  if (typeof origin !== 'string' || !origin) return null;
  try {
    const response = await fetcher(`${origin}${ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'models.list', input: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? Object.freeze({ url: `${origin}${ROUTE}`, token: null }) : null;
  } catch { return null; }
}

/**
 * Builds the transport a served conversation drives, or null when this host has
 * no pane to drive.
 *
 * Why null rather than an error: an operator may run NNA's surface without
 * OpenChamber at all, and a conversation with no page to show must get no browser
 * tool instead of one whose every call fails.
 *
 * Why this order: an explicit binding wins, then a file OpenChamber wrote for
 * itself (verified before use, because a stale file names a dead process), then a
 * probe of the usual ports for an install that publishes nothing readable.
 */
export async function openHostedBrowserTransport({ environment = process.env, ports = [], fetcher, ...rest } = {}) {
  const fetchImpl = fetcher ?? fetch;
  const home = rest.home === undefined ? {} : { home: rest.home };
  const explicit = hostedBrowserBindingFromEnvironment(environment)
    ?? await findHostedBrowserBinding({ environment, ...home });
  if (explicit) return createHostedBrowserTransport(explicit, rest);
  const published = await findHostedBrowserOrigin({ environment, ...home })
    .then((origin) => originAnswers({ origin, fetcher: fetchImpl }))
    .catch(() => null);
  if (published) return createHostedBrowserTransport(published, rest);
  const probed = await probeHostedBrowser({ ports, fetcher: fetchImpl });
  return probed ? createHostedBrowserTransport(probed, rest) : null;
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
      headers: { 'content-type': 'application/json', ...(binding.token ? { authorization: `Bearer ${binding.token}` } : {}) },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (signal?.aborted) throw new ContractError('tool_cancelled', 'browser action was cancelled', { cause: error });
    // Why not "failed": a timeout or a refused connection leaves the outcome
    // unknown for anything that changes a page, and the caller says so.
    throw unavailable('OpenChamber did not answer the browser action', 'hosted_browser_unreachable', error);
  }
}

/**
 * Reads one reply under its bound. The control route answers with the action's
 * data directly, and with `{ error }` and a status when it refuses.
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
  if (response.status === 401) throw unavailable('OpenChamber did not accept this browser credential', 'hosted_browser_unauthorized');
  if (!response.ok) {
    // Read by the model: it says what to do differently, not what broke.
    const message = typeof result?.error === 'string' && result.error ? result.error : `the browser action failed (HTTP ${response.status})`;
    throw unavailable(message.slice(0, 500), 'hosted_browser_failed');
  }
  if (result && typeof result === 'object' && 'error' in result) {
    throw unavailable(String(result.error).slice(0, 500), 'hosted_browser_failed');
  }
  return result;
}

/** Builds the transport a conversation uses to drive the OpenChamber pane. */
export function createHostedBrowserTransport(binding, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  if (!binding || typeof binding.url !== 'string') {
    throw unavailable('the OpenChamber browser binding is invalid', 'hosted_browser_binding_invalid');
  }
  return {
    name: 'openchamber-pane',
    /** @param {string} action @param {object} parameters @param {{signal?: AbortSignal, context?: object}} options */
    async send(action, parameters, { signal, context } = {}) {
      if (!ACTIONS.includes(action)) throw unavailable(`OpenChamber does not accept ${action}`, 'hosted_browser_action_unsupported');
      if (signal?.aborted) throw new ContractError('tool_cancelled', 'browser action was cancelled');
      // The control route takes the action, its inputs and the calling scope in one
      // body; the scope is what keeps one chat's tabs apart from another's.
      const body = boundedBody({
        action,
        input: { ...parameters, action },
        ...(context?.sessionId ? { contextSessionId: context.sessionId } : {}),
        ...(context?.directory ? { contextDirectory: context.directory } : {}),
      });
      return readPaneReply(await postToPane(binding, fetcher, action, body, signal));
    },
  };
}
