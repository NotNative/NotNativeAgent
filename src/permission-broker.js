// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { requestDigest } from './reviewer-ledger.js';
import { PreauthorizationRegistry } from './preauthorization.js';
import { safeToolArguments } from './tool-presentation.js';

export class InteractivePermissionBroker {
  #pending = new Map();

  constructor(options = {}) {
    this.output = options.output ?? (async () => undefined);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxPending = options.maxPending ?? 16;
    this.preauthorizations = new PreauthorizationRegistry({
      ...options.preauthorization, decisionTtlMs: this.timeoutMs,
    });
  }

  async request(request, escalation, context, signal) {
    const oneShot = context.definition?.operatorConfirmation === 'one_shot';
    const grant = oneShot ? null : this.preauthorizations.match(request, context);
    if (grant) return this.preauthorizations.decision(grant, request);
    if (this.#pending.size >= this.maxPending) {
      throw new ContractError('permission_queue_full', 'interactive permission queue is full');
    }
    const token = newId('permission');
    const expiresAt = Date.now() + this.timeoutMs;
    const deferred = createDeferred();
    const pending = { token, request, escalation, context, expiresAt, deferred, oneShot };
    this.#pending.set(token, pending);
    const abort = () => this.#resolveDenied(pending, 'operator_cancelled');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => this.#resolveDenied(pending, 'operator_timeout'), this.timeoutMs);
    await this.output(promptRecord(pending));
    try { return await deferred.promise; } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      this.#pending.delete(token);
    }
  }

  decide(command, principal) {
    const pending = this.#pending.get(command.permission_token);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new ContractError('permission_stale', 'permission request is stale or unavailable');
    }
    if (command.tool_request_id !== pending.request.id) {
      throw new ContractError('permission_mismatch', 'permission decision does not match the pending tool request');
    }
    if (pending.oneShot && !['allow_once', 'deny', 'cancel'].includes(command.choice)) {
      throw new ContractError('permission_choice_invalid', 'this operation only supports one-time approval, denial, or cancellation');
    }
    const grant = ['allow_session', 'allow_workspace'].includes(command.choice)
      ? this.preauthorizations.grant(command.choice, pending.request, pending.context, principal) : null;
    const decision = grant ? this.preauthorizations.decision(grant, pending.request)
      : operatorDecision(command.choice, pending.request, principal, null, this.timeoutMs);
    pending.deferred.resolve(decision);
    return { accepted: true, permission_token: pending.token, outcome: decision.outcome };
  }

  snapshot() {
    return Object.freeze([...this.#pending.values()].map((item) => Object.freeze({
      token: item.token, requestId: item.request.id, tool: item.request.toolName,
      expiresAt: item.expiresAt, summary: safeToolArguments(item.request.args),
    })));
  }

  grants() { return this.preauthorizations.snapshot(); }

  revoke(id, principal) { return this.preauthorizations.revoke(id, principal); }

  #resolveDenied(pending, reason) {
    pending.deferred.resolve(operatorDecision('cancel', pending.request, 'engine', reason, this.timeoutMs));
  }
}

function promptRecord(pending) {
  const definition = pending.context.definition;
  return {
    version: '1.0', type: 'permission_prompt', permission_token: pending.token,
    tool_request_id: pending.request.id, tool: pending.request.toolName,
    action: definition.purpose, scope: definition.scope, effect: definition.sideEffect,
    reversibility: verifiedRecovery(pending.request) ? 'verified_checkpoint' : 'not_verified',
    blast_radius: definition.scope, risk: 'review_required',
    reason_code: pending.escalation.reasonCode, guidance: pending.escalation.guidance,
    arguments: safeToolArguments(pending.request.args), expires_at: pending.expiresAt,
    choices: pending.oneShot ? ['allow_once', 'deny', 'cancel']
      : ['allow_once', 'allow_session', 'allow_workspace', 'deny', 'cancel'],
  };
}

function verifiedRecovery(request) {
  const checkpoint = request.resolved?.recoveryCheckpoint;
  return checkpoint?.verified === true && typeof checkpoint.id === 'string' && checkpoint.id.length > 0;
}

function operatorDecision(choice, request, principal, forcedReason = null, ttlMs = 120_000) {
  const approved = choice === 'allow_once';
  const reasonCode = forcedReason ?? (approved ? 'operator_allow_once' : choice === 'deny' ? 'operator_denied' : 'operator_cancelled');
  return Object.freeze({
    id: newId('decision'), outcome: approved ? 'approve' : 'deny_with_guidance',
    reasonCode, guidance: approved ? null : 'The authenticated operator did not authorize this operation.',
    requestId: request.id, requestDigest: requestDigest(request),
    authorityId: request.authorityId, authorityVersion: request.authorityVersion,
    authorityRestrictionVersion: request.authorityRestrictionVersion ?? 0, policyVersion: request.policyVersion,
    provenance: 'authenticated_interactive_operator', principal,
    committedAt: Date.now(), expiresAt: Date.now() + ttlMs,
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
