// SPDX-License-Identifier: Apache-2.0
/** Token encode/verify internals for the renewable scoped capability
 *  (execution guide 02 L3). Verification enforces the bounded clock skew,
 *  renewal grace, revocation, generation/scope binding, and active-key
 *  identity only after the HMAC comparison succeeds. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ContractError } from './ids.js';

export const PAYLOAD_VERSION = 1;
export const SCOPE = 'nnd-service';
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_TOKEN_CHARACTERS = 16 * 1024;

export function encodeCapabilityToken(payload, key) {
  const encodedPayload = Buffer.from(JSON.stringify({ ...payload, v: PAYLOAD_VERSION }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyCapabilityToken(token, context) {
  assertVerificationContext(context);
  const { boundGeneration, activeKey, activeKeyId, revoked, now, skewMs, graceMs, allowGrace } = context;
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARACTERS || !token.includes('.')) {
    throw new ContractError('capability_invalid', 'capability token is malformed');
  }
  const dot = token.indexOf('.');
  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!BASE64URL.test(encodedPayload) || !BASE64URL.test(signature)) {
    throw new ContractError('capability_invalid', 'capability token must be base64url payload and signature');
  }
  const expected = createHmac('sha256', activeKey).update(encodedPayload).digest('base64url');
  const presented = Buffer.from(signature), expectedBuffer = Buffer.from(expected);
  if (presented.length !== expectedBuffer.length || !timingSafeEqual(presented, expectedBuffer)) {
    throw new ContractError('capability_invalid', 'capability signature is invalid');
  }
  let value;
  try { value = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')); }
  catch { throw new ContractError('capability_invalid', 'capability payload is not JSON'); }
  if (!value || typeof value !== 'object' || value.v !== PAYLOAD_VERSION
    || value.scope !== SCOPE || value.generation !== boundGeneration
    || typeof value.key_id !== 'string' || !value.key_id) {
    throw new ContractError('capability_invalid', 'capability payload is out of scope for this service');
  }
  if (revoked.has(value.key_id)) throw new ContractError('capability_revoked', 'capability key is revoked');
  if (value.key_id !== activeKeyId) throw new ContractError('capability_key_unknown', 'capability key is not active');
  const issuedAt = requiredTime(value.issued_at), expiresAt = requiredTime(value.expires_at);
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp)) {
    throw new ContractError('capability_invalid', 'capability clock must return epoch milliseconds');
  }
  if (issuedAt - timestamp > skewMs) {
    throw new ContractError('capability_skew', 'capability issued_at is beyond the bounded clock skew');
  }
  if (timestamp > expiresAt + (allowGrace ? graceMs : 0)) {
    throw new ContractError('capability_expired', 'capability is expired beyond the renewal grace window');
  }
  return Object.freeze({
    subject_id: requiredText(value.subject_id, 'subject_id'),
    platform_role: requiredText(value.platform_role, 'platform_role'),
    permissions: requiredList(value.permissions),
    workspace_ids: requiredList(value.workspace_ids),
    group_ids: requiredList(value.group_ids),
    subjectId: requiredText(value.subject_id, 'subject_id'),
    platformRole: requiredText(value.platform_role, 'platform_role'),
    workspaceIds: requiredList(value.workspace_ids),
    groupIds: requiredList(value.group_ids),
    keyId: value.key_id, issuedAt, expiresAt,
  });
}

function assertVerificationContext(context) {
  if (!context || typeof context !== 'object') {
    throw new ContractError('capability_invalid', 'capability verification context is invalid');
  }
  const { boundGeneration, activeKey, activeKeyId, revoked, now, skewMs, graceMs } = context;
  // Security: invalid clock inputs must not turn expiry or skew comparisons into false.
  if (typeof now !== 'function' || !Number.isSafeInteger(skewMs) || skewMs < 0
    || !Number.isSafeInteger(graceMs) || graceMs < 0
    || !(revoked instanceof Set) || typeof activeKeyId !== 'string' || !activeKeyId
    || typeof boundGeneration !== 'string' || !boundGeneration
    || !(typeof activeKey === 'string' || Buffer.isBuffer(activeKey)) || !activeKey.length) {
    throw new ContractError('capability_invalid', 'capability context bounds are invalid');
  }
}

function requiredTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ContractError('capability_invalid', 'capability timestamps must be epoch milliseconds');
  }
  return value;
}

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContractError('capability_invalid', `${field} must be bounded printable text`);
  }
  return value.trim();
}

function requiredList(value) {
  if (!Array.isArray(value) || value.length > 512) {
    throw new ContractError('capability_invalid', 'capability authority lists must be bounded arrays');
  }
  return Object.freeze([...new Set(value.map((item) => requiredText(item, 'authority list item')))].sort());
}
