// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { toolCallIdentity } from './tool-call-identity.js';

// Providers can ignore or lack the single-call generation control and emit a
// batch of identical calls. Collapse only byte-independent exact identities here,
// before validation, review, permission reservation, or execution.
export function deduplicateToolCallBatch(input = []) {
  const calls = [];
  const suppressed = [];
  const seen = new Map();
  for (const call of input) {
    const identity = toolCallIdentity(call);
    if (identity === null) {
      calls.push(call);
      continue;
    }
    const retained = seen.get(identity);
    if (!retained) {
      seen.set(identity, call);
      calls.push(call);
      continue;
    }
    suppressed.push(Object.freeze({
      providerCallId: call.providerCallId,
      retainedProviderCallId: retained.providerCallId,
      toolName: call.name,
      identityFingerprint: createHash('sha256').update(identity).digest('hex'),
    }));
  }
  return Object.freeze({ calls: Object.freeze(calls), suppressed: Object.freeze(suppressed) });
}
