// SPDX-License-Identifier: Apache-2.0
// The OpenCode-compatible HTTP server core: auth gate, route table, SSE-ready
// responses, catch-all 404s, and a bounded diagnostics ring. This module owns
// the wire; route-level semantics live with the route table and operations.
import { createServer } from 'node:http';
import { handleV2Request } from './v2-routes.js';
import {
  sendJson, sendEmpty, sendNoContent, sendText, sendUnknownError, readJsonBody, matchesBasicAuthorization, parseTarget, basicAuthorization,
  sseOpen,
} from './protocol.js';
import {
  WIRED_OPENCODE_VERSION, DIAGNOSTICS_ROUTE, DEFAULT_BASIC_USERNAME, DEFAULT_SERVE_HOSTNAME,
} from './version.js';

const RING_LIMIT = 256;

export class OpenCodeCompatServer {
  #options;
  #server = null;
  #ring = [];
  #stats = { requests: 0, errors: 0, unauthorized: 0 };

  constructor(options = {}) {
    this.#options = Object.freeze({
      port: options.port ?? 0,
      hostname: options.hostname ?? DEFAULT_SERVE_HOSTNAME,
      password: typeof options.password === 'string' && options.password.length > 0 ? options.password : null,
      username: options.username ?? DEFAULT_BASIC_USERNAME,
      wiredVersion: options.wiredVersion ?? WIRED_OPENCODE_VERSION,
      registry: options.registry,
      operations: options.operations,
      bus: options.bus ?? null,
      v2: options.v2,
      directory: options.directory ?? process.cwd(),
      config: options.config,
      logger: options.logger,
    });
  }

  async start() {
    this.#server = createServer((req, res) => { void this.#handle(req, res); });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port, this.#options.hostname, () => { this.#server.off('error', reject); resolve(); });
    });
    return { port: this.#server.address().port, url: `http://${this.#options.hostname}:${this.#server.address().port}` };
  }

  async stop() {
    this.#server?.closeAllConnections?.();
    await new Promise((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server = null;
  }

  diagnostics() {
    return {
      version: this.#options.wiredVersion,
      requests: this.#stats.requests,
      errors: this.#stats.errors,
      unauthorized: this.#stats.unauthorized,
      sessions: this.#options.registry?.count?.() ?? null,
      ring: this.#ring.slice(),
    };
  }

  #handle(req, res) {
    const target = parseTarget(req.url ?? '/');
    res.on('finish', () => this.#record(res.statusCode, req?.method, req?.url ?? target?.pathname, res.opencodeErrorCode ?? null));
    res.on('close', () => { if (!res.writableEnded) this.#record(res.statusCode, req?.method, req?.url ?? target?.pathname, 'client_aborted'); });
    if (!this.#authorized(req)) {
      if (target.pathname.startsWith('/api/')) return sendJson(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
      return this.#reject(res, 401, req, target);
    }
    if (target.pathname.startsWith('/api/')) return void handleV2Request({ req, res, target, options: this.#options });
    const route = matchRoute(req.method, target.pathname);
    if (route) return void Promise.resolve(route.handler({ req, res, target, params: route.params, server: this, options: this.#options })).catch((error) => this.#reject(res, 500, req, target, error));
    return this.#reject(res, 404, req, target);
  }

  #authorized(req) {
    if (this.#options.password === null) return true;
    if (matchesBasicAuthorization(req.headers.authorization, this.#options.username, this.#options.password)) return true;
    this.#stats.unauthorized += 1;
    return false;
  }

  #reject(res, status, req, target, error = null) {
    res.opencodeErrorCode = error ? (error.code ?? 'internal_failure') : null;
    this.#options.logger?.record({ type: 'opencode_route_failure', status, code: res.opencodeErrorCode ?? 'internal_failure', url: res.req?.url ?? target?.pathname, ...(error ? { message: error.message } : {}) });
    if (res.writableEnded) return;
    if (res.headersSent) {
      // Why: late handler failures after headers must not crash the response
      // chain with a second writeHead; close the socket instead of lying again.
      this.#options.logger?.record({ type: 'opencode_http_error', status, code: 'late_handler_failure', url: target?.pathname });
      res.end();
      return;
    }
    sendEmpty(res, status);
  }

  #record(status, method, url, code) {
    this.#stats.requests += 1;
    if (status >= 400) this.#stats.errors += 1;
    this.#ring.push({ ts: Date.now(), status, method: method ?? '', url: url ?? '', ...(code ? { code } : {}) });
    if (this.#ring.length > RING_LIMIT) this.#ring.splice(0, this.#ring.length - RING_LIMIT);
  }

  touchRing(status, method, url, code) { this.#record(status, method, url, code); }
}

export { basicAuthorization };

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method.toUpperCase()) continue;
    const params = route.match(pathname);
    if (params) return { params, handler: route.handler };
  }
  return null;
}

const ROUTES = [
  { method: 'GET', match: exact('/global/health'), handler: health },
  { method: 'GET', match: exact(DIAGNOSTICS_ROUTE), handler: diagnostics },
  { method: 'GET', match: exact('/global/event'), handler: globalEventStream },
  { method: 'GET', match: exact('/session'), handler: listSessions },
  { method: 'POST', match: exact('/session'), handler: createSession },
  { method: 'POST', match: prefix('/session/', '/prompt_async'), handler: promptSessionAsync },
  { method: 'POST', match: prefix('/session/', '/message'), handler: promptMessage },
  { method: 'POST', match: prefix('/session/', '/abort'), handler: sessionAbort },
  { method: 'GET', match: prefix('/session/', '/message'), handler: sessionMessages },
  { method: 'DELETE', match: prefix('/session/'), handler: deleteSession },
  { method: 'GET', match: prefix('/session/'), handler: getSession },
  { method: 'POST', match: prefix('/question/', '/reply'), handler: questionReply },
  { method: 'POST', match: prefix('/question/', '/reject'), handler: questionReject },
];

function exact(path) { return (pathname) => (pathname === path ? {} : null); }

function prefix(base, suffix = '') {
  return (pathname) => {
    if (!pathname.startsWith(base)) return null;
    const remainder = pathname.slice(base.length);
    const id = suffix ? (remainder.endsWith(suffix) ? remainder.slice(0, -suffix.length) : null) : remainder;
    if (!id || id.includes('/')) return null;
    return { id: decodeURIComponent(id) };
  };
}

async function health({ res, options }) {
  sendJson(res, 200, { healthy: true, version: options.wiredVersion });
}

async function diagnostics({ res, server }) {
  sendJson(res, 200, server.diagnostics());
}

async function listSessions({ res, options }) {
  sendJson(res, 200, await options.operations.list());
}

async function createSession(ctx) {
  const read = await readJsonBody(ctx.req);
  if (read.error) return sendEmpty(ctx.res, 400);
  const payload = typeof read.value === 'object' && read.value !== null ? read.value : {};
  const created = await ctx.options.operations.create({ title: payload.title, directory: ctx.target.directory ?? payload.directory });
  sendJson(ctx.res, 200, created);
}

async function getSession(ctx) {
  try {
    sendJson(ctx.res, 200, ctx.options.operations.get(ctx.params.id));
  } catch (error) {
    if (error?.code === 'opencode_session_missing') return sendEmpty(ctx.res, 404);
    throw error;
  }
}

async function sessionMessages(ctx) {
  try {
    sendJson(ctx.res, 200, await ctx.options.operations.messages(ctx.params.id));
  } catch (error) {
    if (error?.code === 'opencode_session_missing') return sendEmpty(ctx.res, 404);
    if (error?.code === 'opencode_messages_unsupported') return sendJson(ctx.res, 501, { error: { code: error.code } });
    throw error;
  }
}

// Why: gold OpenCode answers prompt POSTs synchronously (blocking until the
// turn closes), requires application/json (otherwise 415 plain text), and
// reports failures as an UnknownError envelope even for unknown sessions.
async function promptMessage(ctx) {
  const gate = jsonContentGate(ctx.req);
  if (gate) return gate(ctx.res);
  const read = await readJsonBody(ctx.req);
  if (read.error) return sendUnknownError(ctx.res, 400, 'prompt body was malformed JSON');
  try {
    const response = await ctx.options.operations.prompt(ctx.params.id, read.value?.parts ?? []);
    sendJson(ctx.res, 200, response);
  } catch (error) {
    promptFailure(ctx, error);
  }
}

async function promptSessionAsync(ctx) {
  const gate = jsonContentGate(ctx.req);
  if (gate) return gate(ctx.res);
  const read = await readJsonBody(ctx.req);
  if (read.error) return sendUnknownError(ctx.res, 400, 'prompt body was malformed JSON');
  try {
    ctx.options.operations.promptAsync(ctx.params.id, read.value?.parts ?? []).catch((error) => {
      ctx.options.logger?.record({ type: 'opencode_prompt_failed', code: error?.code ?? 'internal_failure', sessionID: ctx.params.id });
    });
    sendNoContent(ctx.res);
  } catch (error) {
    promptFailure(ctx, error);
  }
}

async function globalEventStream(ctx) {
  sseOpen(ctx.res);
  const unsubscribe = ctx.options.bus.subscribe(ctx.res, {
    directory: ctx.target.directory ?? null,
    lastEventId: ctx.req.headers['last-event-id'],
  });
  ctx.res.on('close', unsubscribe);
}

// Why: `POST /session/:id/abort` is the OpenChamber stop button: it cancels
// the active turn through the authenticated engine cancel command and drains
// never-run queued prompts on the wire voice. Unknown sessions are bare 404s
// like GET /session/:id; there is no body to parse.
async function sessionAbort(ctx) {
  try {
    sendJson(ctx.res, 200, await ctx.options.operations.cancel(ctx.params.id));
  } catch (error) {
    if (error?.code === 'opencode_session_missing') return sendEmpty(ctx.res, 404);
    ctx.options.logger?.record({ type: 'opencode_abort_failed', code: error?.code ?? 'internal_failure', sessionID: ctx.params.id });
    sendUnknownError(ctx.res, 500, 'abort failed on the agentic surface');
  }
}

// Why: `/question/:id/reply` and `/question/:id/reject` are the OpenChamber
// question voice; the token is the broker question token, and settlement is
// idempotent only within the broker's pending lifetime (404 once stale).
async function questionReply(ctx) {
  const gate = jsonContentGate(ctx.req);
  if (gate) return gate(ctx.res);
  const read = await readJsonBody(ctx.req);
  if (read.error) return sendUnknownError(ctx.res, 400, 'question reply body was malformed JSON');
  try {
    sendJson(ctx.res, 200, await ctx.options.operations.questionReply(ctx.params.id, read.value ?? {}));
  } catch (error) {
    questionFailure(ctx, error);
  }
}

async function questionReject(ctx) {
  const gate = jsonContentGate(ctx.req);
  if (gate) return gate(ctx.res);
  const read = await readJsonBody(ctx.req);
  if (read.error) return sendUnknownError(ctx.res, 400, 'question reject body was malformed JSON');
  try {
    sendJson(ctx.res, 200, await ctx.options.operations.questionReject(ctx.params.id, read.value ?? {}));
  } catch (error) {
    questionFailure(ctx, error);
  }
}

function questionFailure(ctx, error) {
  if (error?.code === 'question_unknown') return sendEmpty(ctx.res, 404);
  if (['question_request_invalid', 'invalid_id', 'invalid_version', 'unknown_control', 'incompatible_version'].includes(error?.code)) {
    return sendUnknownError(ctx.res, 400, error.message);
  }
  ctx.options.logger?.record({ type: 'opencode_question_failed', code: error?.code ?? 'internal_failure', question_token: ctx.params.id });
  sendUnknownError(ctx.res, 500, 'question settlement failed on the agentic surface');
}

function jsonContentGate(req) {
  const header = req.headers['content-type'];
  if (typeof header === 'string' && header.startsWith('application/json')) return null;
  return (res) => sendText(res, 415, `Unsupported content-type: ${header ?? 'text/plain'}`);
}

function promptFailure(ctx, error) {
  if (error?.code === 'opencode_session_missing') return sendUnknownError(ctx.res, 500, 'failed to resolve prompt session');
  if (typeof error?.code === 'string' && error.code.startsWith('opencode_prompt_')) {
    const overflow = error.code === 'opencode_prompt_queue_overflow';
    return sendUnknownError(ctx.res, overflow ? 429 : 400, error.message);
  }
  ctx.options.logger?.record({ type: 'opencode_prompt_failed', code: error?.code ?? 'internal_failure', sessionID: ctx.params.id });
  sendUnknownError(ctx.res, 500, 'prompt failed on the agentic surface');
}

async function deleteSession(ctx) {
  try {
    await ctx.options.operations.remove(ctx.params.id);
    // Why: gold DELETE answers with the bare boolean `true` on these routes.
    sendJson(ctx.res, 200, true);
  } catch (error) {
    if (error?.code === 'opencode_session_missing') return sendEmpty(ctx.res, 404);
    throw error;
  }
}
