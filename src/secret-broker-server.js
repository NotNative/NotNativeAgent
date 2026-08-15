// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { ContractError } from './ids.js';
import { SecretBroker } from './secret-broker.js';
import { assertNnoIntegrationActivation } from './nno-integration-activation.js';
import {
  authenticateIntegrationRequest, canAccessSecretScope, readIntegrationPrincipal,
  requireIntegrationPermission, requireToken,
} from './integration-principal.js';

const BODY_LIMIT = 96 * 1024;
const ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

// Compatibility export for focused tests. The CLI no longer exposes this as an authority path.
export async function startSecretBrokerServer(options) {
  assertNnoIntegrationActivation(options.activation);
  const host = options.host ?? '127.0.0.1';
  if (!ALLOWED_HOSTS.has(host)) throw new ContractError('secret_broker_bind_invalid', 'secret broker must bind to loopback');
  const port = boundedPort(options.port ?? 0);
  const token = requireToken(options.token);
  const broker = options.broker ?? new SecretBroker(options);
  const server = createServer((request, response) => {
    void authenticatedDispatch(request, response, { broker, token }).catch((error) => sendFailure(response, error));
  });
  setServerBounds(server, options);
  await listen(server, port, host);
  return service(server);
}

export async function dispatchSecretBrokerRequest(request, response, context) {
  const { broker, principal, url } = context;
  if (request.method === 'GET' && url.pathname === '/v1/secrets/audit') {
    requireIntegrationPermission(principal, 'secret.audit');
    const events = await broker.auditEvents(Number(url.searchParams.get('limit') ?? 500));
    return send(response, 200, { events: events.filter((event) => canAccessSecretScope(principal, event.scope)) });
  }
  const match = /^\/v1\/secrets(?:\/([^/]+))?(?:\/(values|status|use))?$/u.exec(url.pathname);
  if (!match) return false;
  const id = match[1] ? decodeURIComponent(match[1]) : null;
  const subresource = match[2] ?? null;
  if (request.method === 'GET' && !id) {
    requireIntegrationPermission(principal, 'secret.read');
    return send(response, 200, { secrets: (await broker.list()).filter((item) => canAccessSecretScope(principal, item.scope)) });
  }
  if (request.method === 'GET' && id && !subresource) {
    requireIntegrationPermission(principal, 'secret.read');
    const secret = await visible(broker, principal, id);
    return secret ? send(response, 200, { secret }) : send(response, 404, failure('not_found', 'secret not found'));
  }
  if (request.method === 'POST' && !id) {
    requireIntegrationPermission(principal, 'secret.manage');
    const body = await readJsonBody(request);
    requireScope(principal, body.scope);
    return send(response, 201, { secret: await broker.create(body) });
  }
  if (request.method === 'PATCH' && id && !subresource) {
    requireIntegrationPermission(principal, 'secret.manage');
    const body = await readJsonBody(request);
    if (body.scope !== undefined) requireScope(principal, body.scope);
    return send(response, 200, { secret: await broker.update(id, body, authorizeSecret(principal)) });
  }
  if (request.method === 'PUT' && id && subresource === 'values') {
    requireIntegrationPermission(principal, 'secret.manage');
    return send(response, 200, { secret: await broker.rotate(id, (await readJsonBody(request)).fields, authorizeSecret(principal)) });
  }
  if (request.method === 'PATCH' && id && subresource === 'status') {
    requireIntegrationPermission(principal, 'secret.manage');
    const body = await readJsonBody(request);
    if (typeof body.enabled !== 'boolean') throw new ContractError('secret_status_invalid', 'enabled must be boolean');
    return send(response, 200, { secret: await broker.setEnabled(id, body.enabled, authorizeSecret(principal)) });
  }
  if (request.method === 'DELETE' && id && !subresource) {
    requireIntegrationPermission(principal, 'secret.manage');
    await broker.remove(id, authorizeSecret(principal));
    return send(response, 200, { ok: true });
  }
  if (request.method === 'POST' && id && subresource === 'use') {
    requireIntegrationPermission(principal, 'secret.use');
    if (!await visible(broker, principal, id)) return send(response, 404, failure('not_found', 'secret not found'));
    const body = await readJsonBody(request);
    return send(response, 200, { fields: await broker.withSecret(id, body, async (values) => values) });
  }
  return send(response, 405, failure('method_not_allowed', 'method is not supported for this endpoint'));
}

export async function readJsonBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ContractError('request_too_large', 'integration request exceeds size bound');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ContractError('request_invalid', 'request body must be valid JSON'); }
}

export function sendFailure(response, error) {
  const code = error?.code ?? 'internal_failure';
  const status = failureStatus(code);
  return send(response, status, failure(code, status === 500 ? 'integration request failed' : error.message));
}

export function send(response, status, value) {
  securityHeaders(response); response.statusCode = status; response.end(`${JSON.stringify(value)}\n`); return true;
}

async function authenticatedDispatch(request, response, context) {
  if (!authenticateIntegrationRequest(request, context.token)) return send(response, 401, failure('unauthenticated', 'valid integration credential required'));
  const principal = readIntegrationPrincipal(request);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (await dispatchSecretBrokerRequest(request, response, { ...context, principal, url })) return;
  return send(response, 404, failure('not_found', 'integration endpoint not found'));
}

async function visible(broker, principal, id) {
  const secret = await broker.get(id);
  return secret && canAccessSecretScope(principal, secret.scope) ? secret : null;
}
function authorizeSecret(principal) {
  return (secret) => {
    if (!canAccessSecretScope(principal, secret.scope)) throw new ContractError('secret_not_found', 'secret not found');
  };
}
function requireScope(principal, scope) {
  if (!canAccessSecretScope(principal, scope)) throw new ContractError('secret_scope_forbidden', 'principal cannot manage the requested secret scope');
}
function failure(code, message) { return { error: { code, message } }; }
function failureStatus(code) {
  if (['principal_required', 'principal_invalid', 'principal_stale'].includes(code)) return 401;
  if (code.includes('permission') || code.includes('forbidden')) return 403;
  if (code.includes('not_found') || code === 'provider_missing') return 404;
  return code === 'internal_failure' ? 500 : 400;
}
function securityHeaders(response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
}
function boundedPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ContractError('secret_broker_port_invalid', 'secret broker port is invalid');
  return port;
}
function setServerBounds(server, options) {
  server.requestTimeout = options.requestTimeoutMs ?? 15_000; server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000; server.maxRequestsPerSocket = 100;
}
function listen(server, port, host) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
}
function service(server) {
  return Object.freeze({ server, address: server.address(), close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) });
}
