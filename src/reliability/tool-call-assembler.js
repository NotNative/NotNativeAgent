// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { reachedOutputCeiling } from './output-headroom.js';

const MAX_TOOL_CALLS = 64;
const MAX_ARGUMENT_BYTES = 262_144;

export class ToolCallAssembler {
  #calls = new Map();
  #argumentBytes = 0;

  add(fragments) {
    if (!Array.isArray(fragments) || fragments.length > MAX_TOOL_CALLS) {
      throw new ContractError('tool_fragments_invalid', 'tool fragments exceed bounds');
    }
    for (const fragment of fragments) this.#addOne(fragment);
  }

  complete(finishReason = null, outputEvidence = {}) {
    return [...this.#calls.values()].sort((a, b) => a.index - b.index).map((call) => {
      const providerCallId = call.providerCallId || syntheticIdentity(call);
      const name = call.name || 'unknown_tool_call';
      if (!call.providerCallId || !call.name) return invalidCall(call, providerCallId, name, 'tool_call_incomplete', 'tool call identity or name is incomplete');
      let args;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        const truncated = reachedOutputCeiling({ ...outputEvidence, finishReason });
        return invalidCall(call, providerCallId, name,
          truncated ? 'tool_arguments_truncated' : 'tool_arguments_malformed',
          truncated ? 'tool arguments were cut off by the provider output limit; retry one smaller bounded call, using the smallest anchored region for edits'
            : 'tool arguments are not valid JSON');
      }
      return Object.freeze({ ...call, providerCallId, name, args: deepFreeze(args) });
    });
  }

  get size() {
    return this.#calls.size;
  }

  get hasEquivalentCompleteCalls() {
    const seen = new Set();
    for (const call of this.#calls.values()) {
      if (!call.providerCallId || !call.name) continue;
      let args;
      // Why: only executable calls participate in duplicate-stop detection. A malformed sibling
      // must not cause streaming to stop before the provider can finish one valid repair call.
      try { args = JSON.parse(call.arguments); } catch { continue; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      const identity = `${call.name}\0${canonicalJson(args)}`;
      if (seen.has(identity)) return true;
      seen.add(identity);
    }
    return false;
  }

  reset() {
    this.#calls.clear();
    this.#argumentBytes = 0;
  }

  #addOne(fragment) {
    if (!Number.isInteger(fragment?.index) || fragment.index < 0 || fragment.index >= MAX_TOOL_CALLS) {
      throw new ContractError('tool_fragment_index', 'tool fragment index is invalid');
    }
    const current = this.#calls.get(fragment.index) ?? {
      index: fragment.index, providerCallId: '', name: '', arguments: '',
    };
    current.providerCallId = appendStable(current.providerCallId, fragment.id);
    if (typeof fragment.function?.name === 'string') current.name += fragment.function.name;
    const addition = argumentFragment(current.arguments, fragment.function?.arguments);
    this.#argumentBytes += Buffer.byteLength(addition, 'utf8');
    if (this.#argumentBytes > MAX_ARGUMENT_BYTES) {
      throw new ContractError('tool_arguments_too_large', 'tool arguments exceed bound');
    }
    current.arguments += addition;
    this.#calls.set(fragment.index, current);
  }
}

function argumentFragment(current, value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && !Array.isArray(value)) {
    let encoded;
    try { encoded = JSON.stringify(value); } catch {
      throw new ContractError('tool_arguments_transport_invalid', 'provider tool arguments are not JSON-compatible');
    }
    if (typeof encoded !== 'string') {
      throw new ContractError('tool_arguments_transport_invalid', 'provider tool arguments are not JSON-compatible');
    }
    // Compatibility: some OpenAI-compatible providers emit one already-parsed
    // argument object instead of streamed JSON text. Accept one complete object,
    // but never concatenate it with a different or partial representation.
    if (current.length === 0) return encoded;
    if (current === encoded) return '';
    throw new ContractError('tool_arguments_transport_drift', 'provider changed the tool argument representation during one call', true);
  }
  throw new ContractError('tool_arguments_transport_invalid', 'provider tool arguments must be JSON text or one JSON object');
}

function invalidCall(call, providerCallId, name, code, message) {
  return Object.freeze({
    index: call.index, providerCallId, name, args: Object.freeze({}),
    invalid: Object.freeze({ code, message }),
  });
}

function syntheticIdentity(call) {
  const digest = createHash('sha256').update(`${call.index}\0${call.name}\0${call.arguments}`).digest('hex').slice(0, 24);
  return `invalid_${digest}`;
}

function appendStable(current, fragment) {
  if (typeof fragment !== 'string' || fragment.length === 0) return current;
  if (current.length === 0) return fragment;
  if (current === fragment) return current;
  // Why: streamed identity fragments are provider transport data. No tool can
  // execute until assembly completes, so a drifted attempt is safe to discard
  // and retry when it has not emitted user-visible text.
  throw new ContractError('tool_identity_drift', 'tool identity changed across fragments', true);
}

function deepFreeze(value, visited = new WeakSet()) {
  if (value && typeof value === 'object' && !visited.has(value)) {
    visited.add(value);
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child, visited);
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
