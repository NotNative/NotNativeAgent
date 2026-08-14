// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';

export class ToolResultCache {
  #entries = new Map();

  constructor(limit = 1024) {
    this.limit = limit;
  }

  lookup(call) {
    const prior = this.#entries.get(call.providerCallId);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint(call)) {
      throw new ContractError('tool_identity_reused', 'tool identity was reused with different arguments');
    }
    return prior.result;
  }

  record(call, result) {
    this.#entries.set(call.providerCallId, Object.freeze({
      fingerprint: fingerprint(call), result: Object.freeze({ ...result }),
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
      tool_name: result.toolName, status: result.status, content: result.content,
      metadata: result.metadata, reason_code: result.reasonCode,
      effect_certainty: result.effectCertainty, elapsed_ms: result.elapsedMs,
      truncated: result.truncated,
    });
  }
}

function fingerprint(call) {
  return createHash('sha256').update(call.name).update('\0').update(JSON.stringify(call.args)).digest('hex');
}
