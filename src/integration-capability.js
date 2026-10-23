// SPDX-License-Identifier: Apache-2.0
/** NNA-issued renewable scoped capability for the supervised NND service
 *  (execution guide 02 L3). A static five-minute principal envelope must not
 *  serve as a permanent service credential: the supervisor issues HMAC-bound
 *  capabilities, renews them without authority expansion, and revokes or
 *  rotates them on restart. The controllable clock (options.now) keeps expiry
 *  and skew testable without weakening them in production. */
import { randomBytes } from 'node:crypto';
import { ContractError } from './ids.js';
import { encodeCapabilityToken, verifyCapabilityToken } from './capability-token.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_GRACE_MS = 60 * 1000;
const DEFAULT_SKEW_MS = 30 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_GRACE_MS = 5 * 60 * 1000;
const MAX_SKEW_MS = 5 * 60 * 1000;
const AUTHORITY_KEYS = Object.freeze([
  'subject_id', 'platform_role', 'permissions', 'workspace_ids', 'group_ids',
]);

export function createCapabilityAuthority({
  generation, principal, key = randomBytes(32).toString('base64url'),
  keyId = `cap_${randomBytes(8).toString('hex')}`, ttlMs = DEFAULT_TTL_MS,
  graceMs = DEFAULT_GRACE_MS, skewMs = DEFAULT_SKEW_MS, now = () => Date.now(),
} = {}) {
  const { boundGeneration, normalizedKeyId, activeKey } = validatedOptions({
    generation, key, keyId, ttlMs, graceMs, skewMs, now,
  });
  const authority = freezeAuthority(principal);
  const state = { activeKey, activeKeyId: normalizedKeyId, revoked: new Set(), boundGeneration };
  const context = (allowGrace) => ({ ...state, now, skewMs, graceMs, allowGrace });
  const issue = () => {
    if (state.revoked.has(state.activeKeyId)) {
      throw new ContractError('capability_revoked', 'rotate the capability key before issuing again');
    }
    const issuedAt = clockTime(now);
    return encodeCapabilityToken({
      ...authorityFields(authority, state), issued_at: issuedAt, expires_at: expiry(issuedAt, ttlMs),
    }, state.activeKey);
  };
  const verifyToken = (token, allowGrace) => verifyCapabilityToken(token, context(allowGrace));
  return Object.freeze({
    issue,
    /** Bind-once: the supervisor learns its discovery generation after the
     *  listener has started, so construction may defer the binding. */
    bind(value) {
      if (state.boundGeneration) throw new ContractError('capability_invalid', 'generation already bound');
      state.boundGeneration = requiredText(value, 'generation');
    },
    /** Renewal preserves subject, workspace, surface, and permitted actions by
     *  construction: the fresh authority is copied from the verified previous
     *  capability, never from caller input. Beyond the grace window renewal
     *  fails and the supervisor must stop privileged child work. */
    renew(token) {
      const verified = verifyToken(token, true);
      for (const field of AUTHORITY_KEYS) {
        if (JSON.stringify(verified[field]) !== JSON.stringify(authority[field])) {
          throw new ContractError('capability_authority_changed', 'renewal must preserve the issued authority');
        }
      }
      const issuedAt = clockTime(now);
      return encodeCapabilityToken({
        ...authorityFields(verified, state), issued_at: issuedAt, expires_at: expiry(issuedAt, ttlMs),
      }, state.activeKey);
    },
    verify: (token) => verifyToken(token, true),
    revoke() { state.revoked.add(state.activeKeyId); },
    rotate() {
      state.revoked.add(state.activeKeyId);
      state.activeKey = randomBytes(32).toString('base64url');
      state.activeKeyId = `cap_${randomBytes(8).toString('hex')}`;
      return state.activeKeyId;
    },
    get keyId() { return state.activeKeyId; },
  });

}

function validatedOptions({ generation, key, keyId, ttlMs, graceMs, skewMs, now }) {
  const boundGeneration = generation === undefined ? undefined : requiredText(generation, 'generation');
  if (typeof now !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS
    || !Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > MAX_GRACE_MS
    || !Number.isSafeInteger(skewMs) || skewMs < 0 || skewMs > MAX_SKEW_MS) {
    throw new ContractError('capability_invalid', 'capability clock and duration bounds are invalid');
  }
  const keyBytes = typeof key === 'string' ? Buffer.byteLength(key, 'utf8')
    : Buffer.isBuffer(key) ? key.length : 0;
  if (keyBytes < 32 || keyBytes > 4096) {
    throw new ContractError('capability_invalid', 'capability signing key must be bounded and at least 32 bytes');
  }
  // Security: a caller wiping or reusing its Buffer cannot change this authority's signing key.
  return { boundGeneration, normalizedKeyId: requiredText(keyId, 'key_id'),
    activeKey: Buffer.isBuffer(key) ? Buffer.from(key) : key };
}

function authorityFields(source, state) {
  if (!state.boundGeneration) throw new ContractError('capability_invalid', 'generation is not bound');
  return {
    key_id: state.activeKeyId, generation: state.boundGeneration, scope: 'nnd-service',
    subject_id: source.subject_id, platform_role: source.platform_role,
    permissions: source.permissions, workspace_ids: source.workspace_ids,
    group_ids: source.group_ids,
  };
}

function clockTime(now) {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp)) {
    throw new ContractError('capability_invalid', 'capability clock must return epoch milliseconds');
  }
  return timestamp;
}

function expiry(issuedAt, ttlMs) {
  const expiresAt = issuedAt + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new ContractError('capability_invalid', 'capability expiry exceeds the clock range');
  }
  return expiresAt;
}

function freezeAuthority(principal) {
  if (!principal || typeof principal !== 'object') {
    throw new ContractError('capability_invalid', 'issued principal is required');
  }
  return Object.freeze({
    subject_id: requiredText(principal.subject_id, 'subject_id'),
    platform_role: requiredText(principal.platform_role, 'platform_role'),
    permissions: requiredList(principal.permissions),
    workspace_ids: requiredList(principal.workspace_ids),
    group_ids: requiredList(principal.group_ids),
  });
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
