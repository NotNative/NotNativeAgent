// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep, join } from 'node:path';
import { ContractError } from './ids.js';
import { loadManagedPlaywright } from './playwright-runtime.js';
import { WebFetchDestinationPolicy, allowedWebAddresses } from './web-fetch-tool.js';

const ACTIONS = new Set(['navigate', 'inspect', 'click', 'fill', 'fill_secret', 'press', 'screenshot', 'close']);
const MAX_TEXT = 65_536;
const MAX_ELEMENTS = 100;
const PROVIDER_TEXT_BYTES = 16_384;
const STATIC_MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.wasm': 'application/wasm',
});

export function webBrowseDefinition(options = {}) {
  const manager = options.manager ?? new BrowserSessionManager(options);
  const definition = {
    name: 'web.browse', version: 1,
    purpose: 'Operate an ephemeral managed Chromium session: navigate, inspect, interact, capture a screenshot, or close it. A workspace HTML path is served by an owned temporary loopback server that is cleaned up with the browser.',
    sideEffect: 'unknown', scope: 'browser', cancellation: true, timeoutMs: 60_000,
    maxOutputBytes: PROVIDER_TEXT_BYTES,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'Required operation. Navigate: set exactly one of url or path. Click: set target. Fill: set target and value. Fill_secret: set target, secret_id, and secret_field. Press: set target and key. Inspect, screenshot, and close need no other fields.' },
        url: { type: 'string', maxLength: 4096, description: 'For action navigate, one complete HTTP(S) URL. Do not combine with path.' },
        path: { type: 'string', maxLength: 4096, description: 'For action navigate, an existing workspace HTML entry file. NNA serves it with an owned temporary loopback server; do not combine with url.' },
        target: { type: 'string', maxLength: 1024, description: 'Required for click, fill, fill_secret, and press: an element reference from inspect (for example e1) or a CSS selector.' },
        value: { type: 'string', maxLength: 20_000, description: 'Required only for action fill: non-secret text.' },
        key: { type: 'string', maxLength: 64, description: 'Required only for action press: a keyboard key or chord such as Enter or Control+A.' },
        secret_id: { type: 'string', maxLength: 128, description: 'Required only for action fill_secret: configured secret-broker id.' },
        secret_field: { type: 'string', maxLength: 64, description: 'Required only for action fill_secret: named field within secret_id.' },
      },
    },
    validate: async (args) => validateBrowseArgs(args, manager),
    executor: (request, signal, execution) => manager.execute(request.args, signal, execution),
  };
  Object.defineProperty(definition, 'manager', { value: manager, enumerable: false });
  return definition;
}

export class BrowserSessionManager {
  constructor(options = {}) {
    this.root = normalizeRoot(options.root);
    this.managedPlaywrightRoot = options.managedPlaywrightRoot;
    this.loadPlaywright = options.loadPlaywright ?? loadManagedPlaywright;
    this.policy = options.policy ?? new WebFetchDestinationPolicy(options.configPath);
    this.paths = options.paths ?? null;
    this.resolveHost = options.resolveHost;
    this.secretBroker = options.secretBroker ?? null;
    this.sessionId = options.sessionId ?? 'session';
    this.browser = null; this.context = null; this.page = null; this.pagePromise = null;
    this.workspaceServer = null;
    this.activeLoopbackOrigin = null;
    this.activeLoopbackDestination = null;
    this.refs = new Map(); this.secretValues = new Set();
  }

  async classifyUrl(value, options = {}) {
    const url = normalizeHttpUrl(value);
    let destination;
    try { destination = await this.policy.classify(url); }
    catch (error) {
      if (!options.reviewableLoopback || error?.code !== 'web_fetch_destination_blocked' || !isExactLoopbackUrl(url)) throw error;
      destination = 'reviewable_loopback_origin';
    }
    await allowedWebAddresses(url, this.resolveHost, destination);
    return { url, destination };
  }

  async classifyRouteUrl(value) {
    const url = normalizeHttpUrl(value);
    if (this.activeLoopbackOrigin === url.origin && isExactLoopbackUrl(url)) {
      const destination = this.activeLoopbackDestination ?? 'reviewable_loopback_origin';
      await allowedWebAddresses(url, this.resolveHost, 'reviewable_loopback_origin');
      return { url, destination };
    }
    return this.classifyUrl(url.href);
  }

  async classifyWorkspacePath(value) {
    if (!this.paths) throw new ContractError('browser_workspace_path_unavailable', 'workspace path navigation is unavailable');
    const resolved = await this.paths.resolveRead(value);
    if (resolved.insideWorkspace !== true || !['.html', '.htm'].includes(extname(resolved.path).toLowerCase())) {
      throw new ContractError('browser_workspace_path_invalid', 'browser workspace navigation requires an HTML file inside the active workspace');
    }
    return resolved;
  }

  async execute(args, signal, execution = {}) {
    try { return await this.#execute(args, signal, execution); }
    catch (error) {
      if (error instanceof ContractError) throw error;
      throw browserOperationFailure(args?.action, error);
    }
  }

  async #execute(args, signal, execution = {}) {
    if (signal?.aborted) throw new ContractError('tool_cancelled', 'browser operation was cancelled');
    if (args.action === 'close') { await this.close(); return result('Browser session closed.', { action: 'close' }); }
    const page = await this.#page();
    if (args.action === 'navigate') {
      const destination = args.path
        ? await this.#workspaceDestination(args.path)
        : await this.classifyUrl(args.url, { reviewableLoopback: true });
      const previousLoopbackOrigin = this.activeLoopbackOrigin;
      const previousLoopbackDestination = this.activeLoopbackDestination;
      this.activeLoopbackOrigin = ['reviewable_loopback_origin', 'managed_workspace_origin'].includes(destination.destination)
        ? destination.url.origin : null;
      this.activeLoopbackDestination = this.activeLoopbackOrigin ? destination.destination : null;
      try { await page.goto(destination.url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
      catch (error) {
        this.activeLoopbackOrigin = previousLoopbackOrigin;
        this.activeLoopbackDestination = previousLoopbackDestination;
        throw error;
      }
      this.refs.clear();
      const workspaceRoute = destination.destination === 'managed_workspace_origin';
      const summary = await this.#summary(page);
      const routeNotice = workspaceRoute
        ? '\n\nVerification route: managed HTTP. This verifies the workspace entry through NNA\'s temporary loopback server; it does not verify direct file:// or double-click launch.'
        : '';
      return result(`${summary}${routeNotice}`, metadata(args.action, page, {
        destination: destination.destination,
        verification_route: workspaceRoute ? 'managed_http' : 'http',
        ...(workspaceRoute ? { source_path: args.path } : {}),
      }));
    }
    if (args.action === 'inspect') return result(await this.#inspect(page), metadata(args.action, page));
    if (args.action === 'screenshot') {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const path = join(this.root, `screenshot-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true });
      return result(`Screenshot saved: ${path}\n\nUse image.inspect with this exact path when visual interpretation is needed.`, metadata('screenshot', page, { path }));
    }
    const locator = this.#locator(page, args.target);
    if (args.action === 'click') await locator.click({ timeout: 15_000 });
    else if (args.action === 'fill') await locator.fill(args.value, { timeout: 15_000 });
    else if (args.action === 'press') await locator.press(args.key, { timeout: 15_000 });
    else if (args.action === 'fill_secret') await this.#fillSecret(locator, args, page, execution);
    this.refs.clear();
    return result(await this.#summary(page), metadata(args.action, page));
  }

  async close() {
    const context = this.context; const browser = this.browser;
    this.page = null; this.pagePromise = null; this.context = null; this.browser = null;
    this.refs.clear(); this.secretValues.clear(); this.activeLoopbackOrigin = null; this.activeLoopbackDestination = null;
    // The browser owns its contexts. Closing Chromium first avoids waiting
    // indefinitely on a page/context that is stalled in navigation or challenge code.
    await browser?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await this.#closeWorkspaceServer();
    if (this.root) await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }

  async #workspaceDestination(path) {
    const entry = await this.classifyWorkspacePath(path);
    if (!this.workspaceServer) this.workspaceServer = await startWorkspaceServer(this.paths);
    const pathname = relative(this.paths.root, entry.path).split(sep).map(encodeURIComponent).join('/');
    const url = new URL(`/${pathname}`, this.workspaceServer.origin);
    return { url, destination: 'managed_workspace_origin' };
  }

  async #closeWorkspaceServer() {
    const owned = this.workspaceServer;
    this.workspaceServer = null;
    if (!owned) return;
    owned.server.closeAllConnections?.();
    await new Promise((done) => owned.server.close(() => done())).catch(() => undefined);
  }

  async #page() {
    if (this.page) return this.page;
    if (this.pagePromise) return this.pagePromise;
    this.pagePromise = this.#openPage();
    try { return await this.pagePromise; }
    finally { this.pagePromise = null; }
  }

  async #openPage() {
    const loaded = await this.loadPlaywright(this.managedPlaywrightRoot);
    this.browser = await loaded.playwright.chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ acceptDownloads: false });
    await this.context.route('**/*', async (route) => {
      const value = route.request().url();
      if (/^(?:about:blank|data:|blob:)/u.test(value)) return route.continue();
      try { await this.classifyRouteUrl(value); return route.continue(); }
      catch { return route.abort('blockedbyclient'); }
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  async #inspect(page) {
    const summary = await this.#summary(page);
    const elements = await page.locator('a,button,input,textarea,select,[role="button"],[role="link"]').evaluateAll((nodes, maximum) => nodes.slice(0, maximum).map((node, index) => ({
      index, tag: node.tagName.toLowerCase(), type: node.getAttribute('type'), role: node.getAttribute('role'),
      text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().slice(0, 240),
    })), MAX_ELEMENTS);
    this.refs.clear();
    const lines = elements.map((item) => {
      const ref = `e${item.index + 1}`; this.refs.set(ref, item.index);
      return `[${ref}] <${item.tag}${item.type ? ` type=${item.type}` : ''}${item.role ? ` role=${item.role}` : ''}> ${item.text}`;
    });
    return `${summary}\n\nInteractive elements (${lines.length}):\n${lines.join('\n')}`;
  }

  async #summary(page) {
    const title = await page.title();
    const text = this.#redact(String(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')).slice(0, MAX_TEXT));
    return `URL: ${page.url()}\nTitle: ${title}\n\n${text}`;
  }

  #locator(page, target) {
    const index = this.refs.get(target);
    return index === undefined
      ? page.locator(target).first()
      : page.locator('a,button,input,textarea,select,[role="button"],[role="link"]').nth(index);
  }

  async #fillSecret(locator, args, page, execution) {
    if (!this.secretBroker) throw new ContractError('secret_broker_unavailable', 'Secret Broker is unavailable for this browser session');
    const decisionId = execution.reviewerDecisionId;
    if (!decisionId) throw new ContractError('secret_review_missing', 'browser secret injection requires a committed reviewer decision');
    await this.secretBroker.withSecret(args.secret_id, {
      consumer: 'web.browse', destination: new URL(page.url()).origin,
      purpose: `Fill browser field ${args.secret_field}`, reviewerDecisionId: decisionId, sessionId: this.sessionId,
    }, async (fields) => {
      if (!(args.secret_field in fields)) throw new ContractError('secret_field_not_found', 'the requested field is not present in this secret');
      this.secretValues.add(fields[args.secret_field]);
      await locator.fill(fields[args.secret_field], { timeout: 15_000 });
    });
  }

  #redact(value) {
    let redacted = value;
    for (const secret of this.secretValues) redacted = redacted.split(secret).join('[nna-redacted:browser-secret]');
    return redacted;
  }
}

async function validateBrowseArgs(args, manager) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.has(args.action)
    || Object.keys(args).some((key) => !['action', 'url', 'path', 'target', 'value', 'key', 'secret_id', 'secret_field'].includes(key))) throw invalid();
  const limits = { url: 4096, path: 4096, target: 1024, value: 20_000, key: 64, secret_id: 128, secret_field: 64 };
  for (const [key, maximum] of Object.entries(limits)) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > maximum || /\u0000/u.test(args[key]))) {
      throw invalid(`browser argument "${key}" is invalid`);
    }
  }
  if (args.action === 'navigate' && (Boolean(args.url) === Boolean(args.path))) {
    throw invalid('browser action "navigate" requires exactly one of argument "url" or "path"');
  }
  const required = { click: ['target'], fill: ['target', 'value'], fill_secret: ['target', 'secret_id', 'secret_field'], press: ['target', 'key'] }[args.action] ?? [];
  const missing = required.find((key) => typeof args[key] !== 'string' || !args[key].length);
  if (missing) throw invalid(`browser action "${args.action}" requires argument "${missing}"`);
  const normalized = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  let destination = null; let origin = null;
  if (args.action === 'navigate' && args.url) { const checked = await manager.classifyUrl(args.url, { reviewableLoopback: true }); normalized.url = checked.url.href; destination = checked.destination; origin = checked.url.origin; }
  if (args.action === 'navigate' && args.path) { const checked = await manager.classifyWorkspacePath(args.path); normalized.path = checked.path; destination = 'managed_workspace_origin'; }
  return { args: normalized, resolved: { action: args.action, destination, origin, path: normalized.path ?? null, readOnly: ['navigate', 'inspect', 'close'].includes(args.action) } };
}

async function startWorkspaceServer(paths) {
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) return respond(response, 405, 'Method not allowed');
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const requested = pathname.replace(/^\/+/, '').replace(/\//gu, sep);
      if (!requested || requested.split(sep).includes('..')) return respond(response, 404, 'Not found');
      const file = await paths.resolveRead(requested);
      if (file.insideWorkspace !== true) return respond(response, 404, 'Not found');
      const body = request.method === 'HEAD' ? null : await readFile(file.path);
      response.writeHead(200, {
        'content-type': STATIC_MIME_TYPES[extname(file.path).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      });
      response.end(body);
    } catch { respond(response, 404, 'Not found'); }
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); done(); });
  });
  server.unref();
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function respond(response, status, content) {
  if (response.headersSent) return response.end();
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(content);
}

function normalizeHttpUrl(value) {
  let url; try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  url.hash = ''; return url;
}
function isExactLoopbackUrl(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
}
function normalizeRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new ContractError('browser_root_invalid', 'browser session root must be absolute');
  return resolve(value);
}
function result(content, metadata) { return { content, metadata }; }
function metadata(action, page, extra = {}) { return { action, url: page.url(), ...extra }; }
function invalid(message = 'web.browse arguments do not match the requested browser action') {
  return new ContractError('tool_schema_invalid', message);
}

function browserOperationFailure(action, error) {
  const operation = typeof action === 'string' && ACTIONS.has(action) ? action : 'unknown';
  const timedOut = error?.name === 'TimeoutError';
  const diagnostic = operation === 'fill_secret' ? '' : boundedBrowserDiagnostic(error?.message);
  const message = `browser action "${operation}" ${timedOut ? 'timed out before it completed' : 'failed'}`
    + (diagnostic ? `: ${diagnostic}` : '');
  const failure = new ContractError(timedOut ? 'browser_action_timeout' : 'browser_action_failed', message, { cause: error });
  failure.toolMetadata = Object.freeze({
    action: operation,
    failure_kind: timedOut ? 'timeout' : 'execution',
    error_name: boundedBrowserErrorName(error?.name),
  });
  return failure;
}

function boundedBrowserDiagnostic(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 512);
}

function boundedBrowserErrorName(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : 'Error';
}
