// SPDX-License-Identifier: Apache-2.0
import { FOUNDATIONAL_TOOL_NAMES } from './core-names.js';

const FOUNDATIONAL_BASELINE = Object.freeze([...FOUNDATIONAL_TOOL_NAMES]);
export const PROVIDER_TOOL_LIMITS = Object.freeze({ count: 32, bytes: 64 * 1024 });

export function planProviderToolNames({
  availableNames = [], workflowLeaseNames = [], allowedNames = null,
  encodedDefinition,
}) {
  const available = new Set(availableNames);
  if (allowedNames) {
    const names = availableNames.filter((name) => allowedNames.has(name));
    return finalize(names, [], 'host_manifest', names.map((name) => [name, 'host_manifest']), encodedDefinition, null);
  }
  const reasons = new Map();
  const protectedNames = new Set();
  const ordered = [];
  const add = (name, reason, protect = false) => {
    if (!available.has(name) || reasons.has(name)) return;
    reasons.set(name, reason); ordered.push(name);
    if (protect) protectedNames.add(name);
  };
  for (const name of FOUNDATIONAL_BASELINE) add(name, 'foundational', true);
  // Why: a committed workflow lease is a provider-surface guarantee. Capacity is checked
  // before the lease is committed, so silently dropping it here would violate that contract.
  for (const name of workflowLeaseNames) add(name, 'workflow_lease', true);
  const limits = PROVIDER_TOOL_LIMITS;
  const selected = [];
  const omitted = [];
  let bytes = 0;
  for (const name of ordered) {
    const definitionBytes = encodedDefinition(name);
    const protectedEntry = protectedNames.has(name);
    if (!protectedEntry && (selected.length >= limits.count || bytes + definitionBytes > limits.bytes)) {
      omitted.push(name);
      reasons.set(name, selected.length >= limits.count ? 'schema_count_limit' : 'schema_byte_limit');
      continue;
    }
    selected.push(name); bytes += definitionBytes;
  }
  return finalize(selected, omitted, 'foundation_with_leases', [...reasons], encodedDefinition, limits);
}

function finalize(names, omitted, composition, reasons, encodedDefinition, limits) {
  const reasonMap = new Map(reasons);
  const bytes = names.reduce((total, name) => total + encodedDefinition(name), 0);
  return Object.freeze({
    composition, names: Object.freeze(names), omitted: Object.freeze(omitted),
    schemaBytes: bytes, limits,
    reasons: Object.freeze(Object.fromEntries(reasonMap)),
  });
}
