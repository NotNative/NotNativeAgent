// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

const MAX_IDENTITY_DEPTH = 64;
const MAX_IDENTITY_NODES = 4_096;

export function recoveryToolIdentity(item) {
  return Object.freeze({
    toolName: item?.request?.toolName ?? item?.call?.name ?? item?.result?.tool_name ?? 'unknown',
    args: item?.request?.args ?? item?.call?.args ?? {},
  });
}

export function recoveryToolFingerprint(toolName, args = {}) {
  return createHash('sha256').update(String(toolName ?? 'unknown')).update('\0')
    .update(stableRecoveryJson(args)).digest('hex');
}

export function stableRecoveryJson(value) {
  const budget = { nodes: 0 };
  try { return serialize(value, new Set(), budget, 0, false) ?? '{}'; }
  catch { return '"[invalid_tool_arguments]"'; }
}

function serialize(value, ancestors, budget, depth, arrayElement) {
  budget.nodes += 1;
  if (depth > MAX_IDENTITY_DEPTH || budget.nodes > MAX_IDENTITY_NODES) return '"[identity_bound]"';
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return arrayElement ? 'null' : undefined;
  }
  if (typeof value === 'bigint') return JSON.stringify(`[bigint:${value}]`);
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (ancestors.has(value)) return '"[circular]"';
  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((entry) => serialize(entry, ancestors, budget, depth + 1, true)).join(',')}]`;
  } else {
    const fields = [];
    for (const key of Object.keys(value).sort()) {
      const entry = serialize(value[key], ancestors, budget, depth + 1, false);
      if (entry !== undefined) fields.push(`${JSON.stringify(key)}:${entry}`);
    }
    serialized = `{${fields.join(',')}}`;
  }
  ancestors.delete(value);
  return serialized;
}
