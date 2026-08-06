// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ContractError } from './ids.js';
import { SecretBroker } from './secret-broker.js';

const BODY_LIMIT = 96 * 1024;
const PRINCIPAL_LIMIT = 16 * 1024;
const ALLOWED_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export async function startSecretBrokerServer(options) {
  const host = options.host ?? '127.0.0.1';
  if (!ALLOWED_HOSTS.has(host)) throw new ContractError('secret_broker_bind_invalid', 'secret broker must bind to loopback');
  const port = Number(options.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new ContractError('secret_broker_port_invalid', 'secret broker port is invalid');
  const token = requireToken(options.token);
  const broker = options.broker ?? new SecretBroker(options);
  const server = createServer((request, response) => {
    void dispatch(request, response, { broker, token }).catch((error) => sendFailure(response, error));
  });
  server.requestTimeout = options.requestTimeoutMs ?? 15_000;
  server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  return Object.freeze({
    server, address: server.address(),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}

async function dispatch(request, response, context) {
  securityHeaders(response);
  if (!authenticate(request, context.token)) return send(response, 401, failure('unauthenticated', 'valid broker credential required'));
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return send(response, 200, { ok: true, service: 'nna-secret-broker', realm: context.broker.realm });
  }
  const principal = readPrincipal(request);
  if (!principal) return send(response, 401, failure('principal_required', 'authenticated NNO principal required'));
  const match = /^\/v1\/secrets(?:\/([^/]+))?(?:\/(values|status))?$/u.exec(url.pathname);
  if (!match) return send(response, 404, failure('not_found', 'broker endpoint not found'));
  const id = match[1] ? decodeURIComponent(match[1]) : null;
  const subresource = match[2] ?? null;
  if (request.method === 'GET' && !id) return list(response, context.broker, principal);
  if (request.method === 'GET' && id && !subresource) return get(response, context.broker, principal, id);
  if (request.method === 'POST' && !id) return create(response, request, context.broker, principal);
  if (request.method === 'PUT' && id && subresource === 'values') return rotate(response, request, context.broker, principal, id);
  if (request.method === 'PATCH' && id && subresource === 'status') return status(response, request, context.broker, principal, id);
  if (request.method === 'DELETE' && id && !subresource) return remove(response, context.broker, principal, id);
  return send(response, 405, failure('method_not_allowed', 'method is not supported for this endpoint'));
}

async function list(response, broker, principal) {
  requirePermission(principal, 'secret.read');
  const secrets = (await broker.list()).filter((secret) => canAccess(principal, secret.scope));
  return send(response, 200, { secrets });
}

async function get(response, broker, principal, id) {
  requirePermission(principal, 'secret.read');
  const secret = await broker.get(id);
  if (!secret || !canAccess(principal, secret.scope)) return send(response, 404, failure('not_found', 'secret not found'));
  return send(response, 200, { secret });
}

async function create(response, request, broker, principal) {
  requirePermission(principal, 'secret.manage');
  const body = await readBody(request);
  if (!canManageScope(principal, body.scope)) throw new ContractError('secret_scope_forbidden', 'principal cannot manage the requested secret scope');
  const secret = await broker.create({ label: body.label, kind: body.kind, fields: body.fields, scope: body.scope });
  return send(response, 201, { secret });
}

async function rotate(response, request, broker, principal, id) {
  requirePermission(principal, 'secret.manage');
  const secret = await manageable(broker, principal, id);
  const body = await readBody(request);
  return send(response, 200, { secret: await broker.rotate(secret.id, body.fields) });
}

async function status(response, request, broker, principal, id) {
  requirePermission(principal, 'secret.manage');
  const secret = await manageable(broker, principal, id);
  const body = await readBody(request);
  if (typeof body.enabled !== 'boolean') throw new ContractError('secret_status_invalid', 'enabled must be boolean');
  return send(response, 200, { secret: await broker.setEnabled(secret.id, body.enabled) });
}

async function remove(response, broker, principal, id) {
  requirePermission(principal, 'secret.manage');
  const secret = await manageable(broker, principal, id);
  await broker.remove(secret.id);
  return send(response, 200, { ok: true });
}

async function manageable(broker, principal, id) {
  const secret = await broker.get(id);
  if (!secret || !canManageScope(principal, secret.scope)) throw new ContractError('secret_not_found', 'secret not found');
  return secret;
}

function readPrincipal(request) {
  const encoded = request.headers['x-nna-principal'];
  if (typeof encoded !== 'string' || encoded.length > PRINCIPAL_LIMIT) return null;
  try { return normalizePrincipal(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); }
  catch { return null; }
}

function normalizePrincipal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const platformRole = ['root', 'admin', 'user'].includes(value.platformRole) ? value.platformRole : null;
  const userId = text(value.userId);
  if (!platformRole || !userId) return null;
  return Object.freeze({
    userId, platformRole,
    permissions: stringList(value.permissions), workspaceIds: stringList(value.workspaceIds),
    groupIds: stringList(value.groupIds), roleIds: stringList(value.roleIds),
  });
}

function requirePermission(principal, permission) {
  if (principal.platformRole === 'root' || principal.platformRole === 'admin') return;
  if (principal.permissions.includes('*') || principal.permissions.includes(permission) || principal.permissions.includes('secret.*')) return;
  throw new ContractError('secret_permission_denied', `${permission} permission required`);
}

function canAccess(principal, scope) {
  if (!scope) return false;
  if (principal.platformRole === 'root' || principal.platformRole === 'admin') return true;
  if (scope.kind === 'user') return scope.id === principal.userId;
  if (scope.kind === 'role') return principal.roleIds.includes(scope.id);
  if (scope.kind === 'group') return principal.groupIds.includes(scope.id);
  if (scope.kind === 'workspace') return principal.workspaceIds.includes(scope.id);
  return scope.kind === 'deployment' && (principal.platformRole === 'root' || principal.platformRole === 'admin');
}

function canManageScope(principal, scope) {
  if (principal.platformRole === 'root' || principal.platformRole === 'admin') return true;
  return canAccess(principal, scope);
}

function authenticate(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const presented = Buffer.from(value.slice(7).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new ContractError('request_too_large', 'broker request exceeds size bound');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ContractError('request_invalid', 'request body must be valid JSON'); }
}

function sendFailure(response, error) {
  const code = error?.code ?? 'internal_failure';
  const statusCode = code.includes('forbidden') || code.includes('permission') ? 403
    : code === 'secret_not_found' ? 404
      : code === 'internal_failure' ? 500 : 400;
  return send(response, statusCode, failure(code, statusCode === 500 ? 'broker request failed' : error.message));
}

function failure(code, message) { return { error: { code, message } }; }
function send(response, status, value) { response.statusCode = status; response.end(`${JSON.stringify(value)}\n`); }
function securityHeaders(response) {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
}
function requireToken(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512 || /[\r\n]/u.test(value)) {
    throw new ContractError('secret_broker_token_invalid', 'broker token must contain 32-512 characters');
  }
  return value;
}
function text(value) { return typeof value === 'string' && value.trim() && value.length <= 128 ? value.trim() : null; }
function stringList(value) { return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))].sort() : []; }
