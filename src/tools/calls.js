// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ContractError } from '../ids.js';

export class ToolCallAssembler {
  #calls = new Map();
  #bytes = 0;

  add(fragments) {
    if (!Array.isArray(fragments) || fragments.length > 64) {
      throw new ContractError('tool_fragments_invalid', 'tool fragments exceed bounds');
    }
    for (const fragment of fragments) this.#addOne(fragment);
  }

  complete() {
    return [...this.#calls.values()].sort((a, b) => a.index - b.index).map((call) => {
      const providerCallId = call.providerCallId || syntheticIdentity(call);
      const name = call.name || 'unknown_tool_call';
      if (!call.providerCallId || !call.name) return invalidCall(call, providerCallId, name, 'tool_call_incomplete', 'tool call identity or name is incomplete');
      let args;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        return invalidCall(call, providerCallId, name, 'tool_arguments_malformed', 'tool arguments are not valid JSON');
      }
      return Object.freeze({ ...call, providerCallId, name, args: deepFreeze(args) });
    });
  }

  get size() {
    return this.#calls.size;
  }

  #addOne(fragment) {
    if (!Number.isInteger(fragment?.index) || fragment.index < 0 || fragment.index >= 64) {
      throw new ContractError('tool_fragment_index', 'tool fragment index is invalid');
    }
    const current = this.#calls.get(fragment.index) ?? {
      index: fragment.index, providerCallId: '', name: '', arguments: '',
    };
    current.providerCallId = appendStable(current.providerCallId, fragment.id);
    if (typeof fragment.function?.name === 'string') current.name += fragment.function.name;
    const addition = typeof fragment.function?.arguments === 'string' ? fragment.function.arguments : '';
    this.#bytes += Buffer.byteLength(addition, 'utf8');
    if (this.#bytes > 262_144) throw new ContractError('tool_arguments_too_large', 'tool arguments exceed bound');
    current.arguments += addition;
    this.#calls.set(fragment.index, current);
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
  if (current.length === 0) return fragment;
  if (current === fragment) return current;
  throw new ContractError('tool_identity_drift', 'tool identity changed across fragments');
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
