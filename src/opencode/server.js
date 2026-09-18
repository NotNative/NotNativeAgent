// SPDX-License-Identifier: Apache-2.0
// The OpenCode-compatible HTTP server core: auth gate, route table, SSE-ready
// responses, catch-all 404s, and a bounded diagnostics ring. This module owns
// the wire; route-level semantics live with the route table and operations.
import { createServer } from 'node:http';
import {
  sendJson, sendEmpty, readJsonBody, matchesBasicAuthorization, parseTarget, basicAuthorization,
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
    if (!this.#authorized(req)) return this.#reject(res, 401, req, target);
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
    if (error) this.#options.logger?.record({ type: 'opencode_http_error', status, code: error.code ?? 'internal_failure', url: target?.pathname });
    if (res.writableEnded) return;
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
  { method: 'GET', match: exact('/session'), handler: listSessions },
  { method: 'POST', match: exact('/session'), handler: createSession },
  { method: 'GET', match: prefix('/session/', '/message'), handler: sessionMessages },
  { method: 'DELETE', match: prefix('/session/'), handler: deleteSession },
  { method: 'GET', match: prefix('/session/'), handler: getSession },
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
  const created = await ctx.options.operations.create({ ...payload, directory: ctx.target.directory ?? payload.directory });
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

async function deleteSession(ctx) {
  try {
    await ctx.options.operations.remove(ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  } catch (error) {
    if (error?.code === 'opencode_session_missing') return sendEmpty(ctx.res, 404);
    throw error;
  }
}
