// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError, newId } from './ids.js';
import { requestDigest } from './persistence/reviewer-ledger.js';

export class PreauthorizationRegistry {
  #grants = [];

  constructor(options = {}) {
    this.maxGrants = options.maxGrants ?? 64;
    this.lifetimeMs = options.lifetimeMs ?? 14_400_000;
    this.decisionTtlMs = options.decisionTtlMs ?? 120_000;
  }

  grant(choice, request, context, principal) {
    assertPreauthorizationInput(request, context);
    if (!['allow_session', 'allow_workspace'].includes(choice)) throw new ContractError('preauthorization_choice_invalid', 'preauthorization choice is invalid');
    if (typeof principal !== 'string' || principal.length === 0 || principal.length > 256) {
      throw new ContractError('preauthorization_principal_invalid', 'authenticated preauthorization principal is required');
    }
    const now = Date.now();
    this.#purge(now);
    if (this.#grants.length >= this.maxGrants) throw new ContractError('preauthorization_full', 'conversation preauthorization limit reached');
    if (!Number.isFinite(request.expiresAt) || request.expiresAt < now) {
      throw new ContractError('preauthorization_request_expired', 'preauthorization request is expired or invalid');
    }
    const scope = choice === 'allow_session' ? 'operation' : 'workspace';
    const grant = Object.freeze({
      id: newId('grant'), scope, toolName: request.toolName,
      definitionVersion: request.definitionVersion, sideEffect: context.definition.sideEffect,
      workspaceRoot: request.workspaceRoot, authorityId: request.authorityId,
      authorityRestrictionVersion: restrictionVersion(request, context),
      policyVersion: request.policyVersion, principal, createdAt: now,
      expiresAt: Math.min(request.expiresAt + this.lifetimeMs, now + this.lifetimeMs),
      targetFingerprint: operationTargetFingerprint(request),
      operationFamilyFingerprint: operationFamilyFingerprint(request),
    });
    this.#grants.push(grant);
    return grant;
  }

  match(request, context) {
    assertPreauthorizationInput(request, context);
    this.#purge(Date.now());
    return this.#grants.find((grant) => grant.authorityId === request.authorityId
      && grant.authorityRestrictionVersion === restrictionVersion(request, context)
      && grant.policyVersion === request.policyVersion && grant.workspaceRoot === request.workspaceRoot
      && grant.toolName === request.toolName && grant.definitionVersion === request.definitionVersion
      && grant.sideEffect === context.definition.sideEffect
      && (grant.scope === 'workspace'
        ? grant.operationFamilyFingerprint === operationFamilyFingerprint(request)
        : grant.targetFingerprint === operationTargetFingerprint(request))) ?? null;
  }

  snapshot() {
    this.#purge(Date.now());
    return Object.freeze(this.#grants.map((grant) => Object.freeze({
      id: grant.id, scope: grant.scope, tool: grant.toolName, effect: grant.sideEffect,
      target_fingerprint: grant.targetFingerprint, restriction_version: grant.authorityRestrictionVersion,
      operation_family_fingerprint: grant.operationFamilyFingerprint,
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
    if (!grant || typeof grant !== 'object' || !request || typeof request !== 'object') {
      throw new ContractError('preauthorization_decision_invalid', 'preauthorization grant and request are required');
    }
    const now = Date.now();
    return Object.freeze({
      id: newId('decision'), outcome: 'approve', reasonCode: `operator_preauthorized_${grant.scope}`,
      guidance: null, requestId: request.id, requestDigest: requestDigest(request),
      authorityId: request.authorityId, authorityVersion: request.authorityVersion,
      authorityRestrictionVersion: grant.authorityRestrictionVersion, policyVersion: request.policyVersion,
      provenance: 'authenticated_interactive_operator', principal: grant.principal,
      grantId: grant.id, committedAt: now, expiresAt: now + this.decisionTtlMs,
    });
  }

  #purge(now) { this.#grants = this.#grants.filter((grant) => grant.expiresAt >= now); }
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
    : targets.length > 0 ? { targets } : { args: request.args ?? null };
  return fingerprint(JSON.stringify(canonical(identity)));
}

function operationFamilyFingerprint(request) {
  const resolved = request.resolved ?? {};
  if (request.toolName === 'process.run') {
    const executable = commandName(resolved.executable);
    const argv = Array.isArray(resolved.argv) ? resolved.argv : [];
    return fingerprint(JSON.stringify(canonical({
      executable,
      operation: processOperation(executable, argv),
      complexity: resolved.reviewComplexity ?? null,
      purpose: resolved.reviewPurpose ?? null,
    })));
  }
  if (request.toolName === 'shell.run') {
    return fingerprint(JSON.stringify(canonical({
      shell: resolved.shell ?? null,
      commands: shellCommandFamily(resolved.script),
      complexity: resolved.reviewComplexity ?? null,
      purpose: resolved.reviewPurpose ?? null,
    })));
  }
  return fingerprint(request.toolName);
}

function processOperation(executable, argv) {
  if (['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'sh', 'bash', 'zsh', 'fish'].includes(executable)) {
    const family = shellCommandFamily(argv.at(-1));
    return family.length > 0 ? family : ['shell_invocation_without_command'];
  }
  const significant = argv.filter((value) => typeof value === 'string' && !value.startsWith('-'));
  return significant.slice(0, 2).map((value) => value.toLowerCase());
}

function shellCommandFamily(script) {
  if (typeof script !== 'string') return [];
  return script.split(/(?:\r?\n|&&|\|\||[|;])/u).map((segment) => {
    const match = segment.trim().match(/^(?:&\s*)?(?:["']?)([^\s"']+)/u);
    return commandName(match?.[1]);
  }).filter(Boolean);
}

function commandName(value) {
  if (typeof value !== 'string') return null;
  return value.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function restrictionVersion(request, context) {
  return request.authorityRestrictionVersion ?? context.authority?.restrictionVersion ?? 0;
}

function assertPreauthorizationInput(request, context) {
  if (!request || typeof request !== 'object' || typeof request.toolName !== 'string'
      || !context || typeof context !== 'object' || typeof context.definition?.sideEffect !== 'string') {
    throw new ContractError('preauthorization_input_invalid', 'preauthorization requires a valid request and tool context');
  }
}
