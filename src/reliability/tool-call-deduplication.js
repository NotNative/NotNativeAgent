// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

// Providers occasionally ignore parallel_tool_calls=false and emit a batch of
// identical calls. Collapse only byte-independent exact identities here,
// before validation, review, permission reservation, or execution.
export function deduplicateToolCallBatch(input = []) {
  const calls = [];
  const suppressed = [];
  const seen = new Map();
  for (const call of input) {
    if (call?.invalid || typeof call?.name !== 'string' || !call.args
      || typeof call.args !== 'object' || Array.isArray(call.args)) {
      calls.push(call);
      continue;
    }
    const canonicalArguments = canonicalJson(call.args);
    const identity = `${call.name}\0${canonicalArguments}`;
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

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
