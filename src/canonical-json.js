// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const DEFAULT_MAX_DEPTH = 512;

/** Serialize a JSON-shaped value with sorted object keys so an identity is
 *  independent of insertion order. `onInvalid(reason, value)` decides how a
 *  cycle, a non-finite number, an unsupported value, or an over-deep graph is
 *  handled; it must throw or return the text used for that value. */
export function canonicalJson(value, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const onInvalid = options.onInvalid ?? ((reason) => {
    throw new ContractError('canonical_json_invalid', `canonical JSON rejected ${reason}`);
  });
  const ancestors = new Set();
  const encode = (current, depth) => {
    if (depth > maxDepth) return onInvalid('too_deep', current);
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return onInvalid('non_finite', current);
      return JSON.stringify(current);
    }
    if (typeof current !== 'object') return onInvalid('unsupported', current);
    if (ancestors.has(current)) return onInvalid('cycle', current);
    ancestors.add(current);
    const text = Array.isArray(current)
      ? `[${current.map((item) => encode(item, depth + 1)).join(',')}]`
      : `{${Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${encode(current[key], depth + 1)}`).join(',')}}`;
    ancestors.delete(current);
    return text;
  };
  return encode(value, 0);
}
