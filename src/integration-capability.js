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
const AUTHORITY_KEYS = Object.freeze([
  'subject_id', 'platform_role', 'permissions', 'workspace_ids', 'group_ids',
]);

export function createCapabilityAuthority({
  generation, principal, key = randomBytes(32).toString('base64url'),
  keyId = `cap_${randomBytes(8).toString('hex')}`, ttlMs = DEFAULT_TTL_MS,
  graceMs = DEFAULT_GRACE_MS, skewMs = DEFAULT_SKEW_MS, now = () => Date.now(),
} = {}) {
  if (generation !== undefined && (typeof generation !== 'string' || !generation.trim())) {
    throw new ContractError('capability_invalid', 'generation required');
  }
  const authority = freezeAuthority(principal);
  const state = { activeKey: key, activeKeyId: keyId, revoked: new Set(), boundGeneration: generation };
  const context = (allowGrace) => ({ ...state, now, skewMs, graceMs, allowGrace });
  const issue = () => encodeCapabilityToken({
    ...authorityFields(authority), issued_at: now(), expires_at: now() + ttlMs,
  }, state.activeKey);
  const verifyToken = (token, allowGrace) => verifyCapabilityToken(token, context(allowGrace));
  return Object.freeze({
    issue,
    /** Bind-once: the supervisor learns its discovery generation after the
     *  listener has started, so construction may defer the binding. */
    bind(value) {
      if (state.boundGeneration) throw new ContractError('capability_invalid', 'generation already bound');
      if (typeof value !== 'string' || !value.trim()) throw new ContractError('capability_invalid', 'generation required');
      state.boundGeneration = value;
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
      return encodeCapabilityToken({
        ...authorityFields(verified), issued_at: now(), expires_at: now() + ttlMs,
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

  function authorityFields(source) {
    if (!state.boundGeneration) throw new ContractError('capability_invalid', 'generation is not bound');
    return {
      key_id: state.activeKeyId, generation: state.boundGeneration, scope: 'nnd-service',
      subject_id: source.subject_id, platform_role: source.platform_role,
      permissions: source.permissions, workspace_ids: source.workspace_ids,
      group_ids: source.group_ids,
    };
  }
}

function freezeAuthority(principal) {
  if (!principal || typeof principal !== 'object') {
    throw new ContractError('capability_invalid', 'issued principal is required');
  }
  const fields = {};
  for (const field of AUTHORITY_KEYS) fields[field] = principal[field];
  requiredText(fields.subject_id, 'subject_id');
  requiredText(fields.platform_role, 'platform_role');
  requiredList(fields.permissions);
  requiredList(fields.workspace_ids);
  requiredList(fields.group_ids);
  return Object.freeze(fields);
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
