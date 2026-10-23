// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';
import { reachedOutputCeiling } from './output-headroom.js';
import { toolCallIdentity } from './tool-call-identity.js';

const MAX_TOOL_CALLS = 64;
const MAX_ARGUMENT_BYTES = 262_144;
const MAX_TOOL_NAME_BYTES = 512;
const MAX_PROVIDER_CALL_ID_BYTES = 512;
const INCOMPLETE_TOOL_NAME = 'unknown_tool_call';

export class ToolCallAssembler {
  #calls = new Map();
  #argumentBytes = 0;
  #equivalentCache;

  add(fragments) {
    if (!Array.isArray(fragments)) {
      throw new ContractError('tool_fragments_invalid', 'tool fragments must be an array');
    }
    if (fragments.length > MAX_TOOL_CALLS) {
      throw new ContractError('tool_fragments_invalid', 'tool fragments exceed bounds');
    }
    // Invariant: a rejected provider event cannot mutate an earlier valid fragment.
    const calls = new Map(this.#calls);
    let argumentBytes = this.#argumentBytes;
    let changed = false;
    for (const fragment of fragments) {
      const result = addOne(calls, fragment, argumentBytes);
      argumentBytes = result.argumentBytes;
      changed ||= result.changed;
    }
    this.#calls = calls;
    this.#argumentBytes = argumentBytes;
    if (changed) this.#equivalentCache = undefined;
  }

  complete(finishReason = null, outputEvidence = {}) {
    return [...this.#calls.values()].sort((a, b) => a.index - b.index).map((call) => {
      const providerCallId = call.providerCallId || syntheticIdentity(call);
      const name = call.name || INCOMPLETE_TOOL_NAME;
      if (!call.providerCallId || !call.name) return invalidCall(call, providerCallId, name, 'tool_call_incomplete', 'tool call identity or name is incomplete');
      let args;
      try {
        args = parseArguments(call.arguments);
      } catch {
        const truncated = reachedOutputCeiling({ ...outputEvidence, finishReason });
        return invalidCall(call, providerCallId, name,
          truncated ? 'tool_arguments_truncated' : 'tool_arguments_malformed',
          truncated ? 'tool arguments were cut off by the provider output limit; retry one smaller bounded call, using the smallest anchored region for edits'
            : 'tool arguments are not valid JSON');
      }
      if (!validArgumentsObject(args)) {
        return invalidCall(call, providerCallId, name, 'tool_arguments_malformed', 'tool arguments must be a JSON object');
      }
      return Object.freeze({ ...call, providerCallId, name, args: deepFreeze(args) });
    });
  }

  get size() {
    return this.#calls.size;
  }

  get hasEquivalentCompleteCalls() {
    if (this.#equivalentCache !== undefined) return this.#equivalentCache;
    const seen = new Set();
    for (const call of this.#calls.values()) {
      if (!call.providerCallId || !call.name) continue;
      // Invariant: blank arguments are valid only at the terminal boundary.
      // A later fragment may still carry required fields for this call.
      if (call.arguments.trim().length === 0) continue;
      let args;
      // Why: only executable calls participate in duplicate-stop detection. A malformed sibling
      // must not cause streaming to stop before the provider can finish one valid repair call.
      try { args = parseArguments(call.arguments); } catch { continue; }
      if (!validArgumentsObject(args)) continue;
      const identity = toolCallIdentity({ name: call.name, args });
      if (identity === null) continue;
      if (seen.has(identity)) { this.#equivalentCache = true; return true; }
      seen.add(identity);
    }
    this.#equivalentCache = false;
    return false;
  }

  reset() {
    this.#calls.clear();
    this.#argumentBytes = 0;
    this.#equivalentCache = undefined;
  }
}

function addOne(calls, fragment, argumentBytes) {
  if (!Number.isInteger(fragment?.index) || fragment.index < 0 || fragment.index >= MAX_TOOL_CALLS) {
    throw new ContractError('tool_fragment_index', 'tool fragment index is invalid');
  }
  const current = calls.get(fragment.index) ?? {
    index: fragment.index, providerCallId: '', name: '', arguments: '',
  };
  const providerCallId = appendStable(current.providerCallId, fragment.id);
  const name = appendName(current.name, fragment.function?.name);
  const addition = argumentFragment(current.arguments, fragment.function?.arguments, name);
  const nextArgumentBytes = argumentBytes + Buffer.byteLength(addition, 'utf8');
  if (nextArgumentBytes > MAX_ARGUMENT_BYTES) {
    throw new ContractError('tool_arguments_too_large', 'tool arguments exceed bound');
  }
  const next = { index: fragment.index, providerCallId, name, arguments: current.arguments + addition };
  const changed = !calls.has(fragment.index) || providerCallId !== current.providerCallId
    || name !== current.name || addition.length > 0;
  if (changed) calls.set(fragment.index, next);
  return { argumentBytes: nextArgumentBytes, changed };
}

function argumentFragment(current, value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    // Compatibility: a complete JSON argument object can be repeated as text.
    // Partial text remains a delta because it cannot safely be distinguished from cumulative text.
    return equivalentCompleteArguments(current, value, name) ? '' : value;
  }
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
    if (equivalentCompleteArguments(current, value, name)) return '';
    throw new ContractError('tool_arguments_transport_drift', 'provider changed the tool argument representation during one call', true);
  }
  throw new ContractError('tool_arguments_transport_invalid', 'provider tool arguments must be JSON text or one JSON object');
}

function equivalentCompleteArguments(current, incoming, name) {
  if (!current || !name) return false;
  // Why: skip reparsing the growing buffer for ordinary argument deltas.
  if (typeof incoming === 'string'
    && (incoming.trimStart()[0] !== '{' || incoming.trimEnd().at(-1) !== '}')) return false;
  if (current.trimStart()[0] !== '{' || current.trimEnd().at(-1) !== '}') return false;
  try {
    const prior = JSON.parse(current);
    const next = typeof incoming === 'string' ? JSON.parse(incoming) : incoming;
    if (!validArgumentsObject(prior) || !validArgumentsObject(next)) return false;
    const priorIdentity = toolCallIdentity({ name, args: prior });
    return priorIdentity !== null && priorIdentity === toolCallIdentity({ name, args: next });
  } catch {
    return false;
  }
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
  if (Buffer.byteLength(fragment, 'utf8') > MAX_PROVIDER_CALL_ID_BYTES) {
    throw new ContractError('tool_provider_call_id_too_large', 'provider call ID exceeds bound');
  }
  if (current.length === 0) return fragment;
  if (current === fragment) return current;
  // Why: streamed identity fragments are provider transport data. No tool can
  // execute until assembly completes, so a drifted attempt is safe to discard
  // and retry when it has not emitted user-visible text.
  throw new ContractError('tool_identity_drift', 'tool identity changed across fragments', true);
}

function appendName(current, fragment) {
  if (typeof fragment !== 'string' || fragment.length === 0) return current;
  // Compatibility: adapters may emit deltas or repeat the cumulative tool name.
  const next = current.length === 0 || fragment.startsWith(current) ? fragment
    : current === fragment ? current : current + fragment;
  if (Buffer.byteLength(next, 'utf8') > MAX_TOOL_NAME_BYTES) {
    throw new ContractError('tool_name_too_large', 'provider tool name exceeds bound');
  }
  return next;
}

function parseArguments(value) { return value.trim().length === 0 ? {} : JSON.parse(value); }
function validArgumentsObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function deepFreeze(value) {
  // Why: JSON input is byte-bounded, but may be deeply nested before schema validation.
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) continue;
    Object.freeze(current);
    for (const child of Object.values(current)) stack.push(child);
  }
  return value;
}
