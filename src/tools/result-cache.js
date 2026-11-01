// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { toolLifecycleStatus, toolReviewOutcome } from './tool-result-contract.js';
import { canonicalJson } from '../canonical-json.js';
import { deepFreeze } from '../values.js';

const DEFAULT_CACHE_LIMIT = 1_024;

export class ToolResultCache {
  #entries = new Map();

  constructor(limit = DEFAULT_CACHE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ContractError('tool_cache_limit_invalid', 'tool cache limit must be a positive integer');
    this.limit = limit;
  }

  lookup(call) {
    validateCall(call);
    const prior = this.#entries.get(call.providerCallId);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint(call)) {
      throw new ContractError('tool_identity_reused', 'tool identity was reused with different arguments');
    }
    this.#entries.delete(call.providerCallId);
    this.#entries.set(call.providerCallId, prior);
    return prior.result;
  }

  record(call, result) {
    validateCall(call);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ContractError('tool_result_invalid', 'tool cache result must be an object');
    }
    const snapshot = deepFreeze(structuredClone(result));
    this.#entries.delete(call.providerCallId);
    this.#entries.set(call.providerCallId, Object.freeze({
      fingerprint: fingerprint(call), result: snapshot,
    }));
    while (this.#entries.size > this.limit) this.#entries.delete(this.#entries.keys().next().value);
  }

  restore(transcript) {
    const requests = new Map();
    for (const item of transcript) {
      if (item.type === 'tool_request') requests.set(item.providerCallId, item);
      if (item.type === 'tool_result') this.#restoreResult(requests.get(item.providerCallId), item);
    }
  }

  #restoreResult(request, result) {
    if (!request) return;
    this.record({ providerCallId: request.providerCallId, name: request.toolName, args: request.args }, {
      request_id: result.requestId, provider_call_id: result.providerCallId,
      tool_name: result.toolName, status: toolLifecycleStatus(result), content: result.content,
      ...(toolReviewOutcome(result) ? { review_outcome: toolReviewOutcome(result) } : {}),
      metadata: result.metadata, reason_code: result.reasonCode,
      effect_certainty: result.effectCertainty, elapsed_ms: result.elapsedMs,
      truncated: result.truncated,
    });
  }
}

function fingerprint(call) {
  return createHash('sha256').update(call.name).update('\0')
    .update(canonicalJson(call.args, {
      maxDepth: 256,
      onInvalid: (reason) => {
        throw new ContractError('tool_call_invalid', reason === 'cycle'
          ? 'tool arguments must not be cyclic' : 'tool arguments must be JSON-compatible');
      },
    })).digest('hex');
}

function validateCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)
    || typeof call.providerCallId !== 'string' || !call.providerCallId
    || typeof call.name !== 'string' || !call.name
    || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new ContractError('tool_call_invalid', 'tool cache call must contain an identity, name, and argument object');
  }
}

