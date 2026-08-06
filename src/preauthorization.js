// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError, newId } from './ids.js';
import { requestDigest } from './reviewer-ledger.js';

export class PreauthorizationRegistry {
  #grants = [];

  constructor(options = {}) {
    this.maxGrants = options.maxGrants ?? 64;
    this.lifetimeMs = options.lifetimeMs ?? 14_400_000;
  }

  grant(choice, request, context, principal) {
    this.#purge();
    if (this.#grants.length >= this.maxGrants) throw new ContractError('preauthorization_full', 'conversation preauthorization limit reached');
    const scope = choice === 'allow_session' ? 'operation' : 'workspace';
    const grant = Object.freeze({
      id: newId('grant'), scope, toolName: request.toolName,
      definitionVersion: request.definitionVersion, sideEffect: context.definition.sideEffect,
      workspaceRoot: request.workspaceRoot, authorityId: request.authorityId,
      authorityRestrictionVersion: request.authorityRestrictionVersion ?? context.authority?.restrictionVersion ?? 0,
      policyVersion: request.policyVersion, principal, createdAt: Date.now(),
      expiresAt: Math.min(request.expiresAt + this.lifetimeMs, Date.now() + this.lifetimeMs),
      targetFingerprint: operationTargetFingerprint(request),
    });
    this.#grants.push(grant);
    return grant;
  }

  match(request, context) {
    this.#purge();
    return this.#grants.find((grant) => grant.authorityId === request.authorityId
      && grant.authorityRestrictionVersion === (request.authorityRestrictionVersion ?? context.authority?.restrictionVersion ?? 0)
      && grant.policyVersion === request.policyVersion && grant.workspaceRoot === request.workspaceRoot
      && grant.toolName === request.toolName && grant.definitionVersion === request.definitionVersion
      && grant.sideEffect === context.definition.sideEffect
      && (grant.scope === 'workspace' || grant.targetFingerprint === operationTargetFingerprint(request))) ?? null;
  }

  snapshot() {
    this.#purge();
    return Object.freeze(this.#grants.map((grant) => Object.freeze({
      id: grant.id, scope: grant.scope, tool: grant.toolName, effect: grant.sideEffect,
      target_fingerprint: grant.targetFingerprint, restriction_version: grant.authorityRestrictionVersion,
      expires_at: grant.expiresAt,
    })));
  }

  revoke(id, principal) {
    const index = this.#grants.findIndex((grant) => grant.id === id);
    if (index < 0) throw new ContractError('preauthorization_missing', 'conversation preauthorization was not found');
    const [grant] = this.#grants.splice(index, 1);
    return Object.freeze({ revoked: true, id: grant.id, principal });
  }

  decision(grant, request) {
    return Object.freeze({
      id: newId('decision'), outcome: 'approve', reasonCode: `operator_preauthorized_${grant.scope}`,
      guidance: null, requestId: request.id, requestDigest: requestDigest(request),
      authorityId: request.authorityId, authorityVersion: request.authorityVersion,
      authorityRestrictionVersion: request.authorityRestrictionVersion ?? 0, policyVersion: request.policyVersion,
      provenance: 'authenticated_interactive_operator', principal: grant.principal,
      grantId: grant.id, committedAt: Date.now(), expiresAt: Math.min(request.expiresAt, Date.now() + 30_000),
    });
  }

  #purge() { this.#grants = this.#grants.filter((grant) => grant.expiresAt >= Date.now()); }
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function operationTargetFingerprint(request) {
  const resolved = request.resolved ?? {};
  const targets = [resolved.path, resolved.source?.path ?? resolved.source, resolved.destination?.path ?? resolved.destination]
    .filter((value) => typeof value === 'string');
  const identity = request.toolName === 'process.run'
    ? { targets, executable: resolved.executable, argv: resolved.argv }
    : request.toolName === 'shell.run'
      ? { targets, shell: resolved.shell, script: resolved.script }
    : targets.length > 0 ? { targets } : { args: request.args };
  return fingerprint(JSON.stringify(canonical(identity)));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
