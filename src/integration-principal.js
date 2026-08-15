// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from 'node:crypto';
import { ContractError } from './ids.js';

const PRINCIPAL_LIMIT = 16 * 1024;
const MAX_AGE_MS = 5 * 60 * 1000;
const MIN_TOKEN_CHARACTERS = 32;
const MAX_TOKEN_CHARACTERS = 512;
const MAX_TEXT_CHARACTERS = 256;
const MAX_LIST_ITEMS = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ALLOWED_KEYS = new Set([
  'subject_id', 'platform_role', 'permissions', 'workspace_ids', 'group_ids',
  'trace_id', 'issued_at', 'request_id',
]);

export function authenticateIntegrationRequest(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const presented = Buffer.from(value.slice(7).trim(), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function readIntegrationPrincipal(request, options = {}) {
  const encoded = request.headers['x-nna-principal'];
  if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > PRINCIPAL_LIMIT) {
    throw new ContractError('principal_required', 'authenticated NNO principal required');
  }
  if (!BASE64URL.test(encoded)) {
    throw new ContractError('principal_invalid', 'X-NNA-Principal must contain strict unpadded base64url');
  }
  let value;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new ContractError('principal_invalid', 'X-NNA-Principal must contain base64url-encoded JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new ContractError('principal_invalid', 'NNO principal envelope has an invalid shape');
  }
  const principal = Object.freeze({
    subjectId: requiredText(value.subject_id, 'subject_id'),
    platformRole: requiredText(value.platform_role, 'platform_role'),
    permissions: requiredList(value.permissions, 'permissions'),
    workspaceIds: requiredList(value.workspace_ids, 'workspace_ids'),
    groupIds: requiredList(value.group_ids, 'group_ids'),
    traceId: requiredText(value.trace_id, 'trace_id'),
    issuedAt: requiredDate(value.issued_at),
    requestId: requiredText(value.request_id, 'request_id'),
  });
  const now = options.now?.() ?? Date.now();
  if (Math.abs(now - principal.issuedAt.getTime()) > (options.maxAgeMs ?? MAX_AGE_MS)) {
    throw new ContractError('principal_stale', 'NNO principal envelope is stale');
  }
  return principal;
}

export function requireIntegrationPermission(principal, permission) {
  if (principal.permissions.includes('*') || principal.permissions.includes(permission)) return;
  // A domain wildcard intentionally covers every nested permission depth.
  const domain = `${permission.split('.')[0]}.*`;
  if (principal.permissions.includes(domain)) return;
  throw new ContractError('integration_permission_denied', `${permission} permission required`);
}

export function canAccessSecretScope(principal, scope) {
  if (!scope || typeof scope !== 'object') return false;
  if (principal.permissions.includes('secret.scope.all')) return true;
  if (scope.kind !== 'deployment' && typeof scope.id !== 'string') return false;
  if (scope.kind === 'user') return scope.id === principal.subjectId;
  if (scope.kind === 'workspace') return principal.workspaceIds.includes(scope.id);
  if (scope.kind === 'group') return principal.groupIds.includes(scope.id);
  if (scope.kind === 'role') return principal.permissions.includes(`secret.scope.role:${scope.id}`);
  if (scope.kind === 'deployment') return principal.permissions.includes('secret.scope.deployment');
  return false;
}

export function requireToken(value) {
  if (typeof value !== 'string' || value.length < MIN_TOKEN_CHARACTERS
    || value.length > MAX_TOKEN_CHARACTERS || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContractError('integration_token_invalid',
      `integration token must contain ${MIN_TOKEN_CHARACTERS}-${MAX_TOKEN_CHARACTERS} non-whitespace characters`);
  }
  return value;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARACTERS
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContractError('principal_invalid', `${field} must be bounded printable text`);
  }
  return value.trim();
}

function requiredList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new ContractError('principal_invalid', `${field} must be a bounded array`);
  }
  // Authorization lists are canonical sets; source order carries no priority.
  return Object.freeze([...new Set(value.map((item) => requiredText(item, field)))].sort());
}

function requiredDate(value) {
  const text = requiredText(value, 'issued_at');
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new ContractError('principal_invalid', 'issued_at must be an ISO-8601 timestamp');
  return date;
}
