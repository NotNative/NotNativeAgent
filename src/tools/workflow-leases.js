// SPDX-License-Identifier: Apache-2.0

const MAX_USES = 32;
const MAX_SOURCES = 8;

export function grantWorkflowLeases(leases, names, options, capacityFor) {
  const uses = Number.isSafeInteger(options.uses) ? Math.max(1, Math.min(MAX_USES, options.uses)) : 1;
  const source = boundedSource(options.source);
  const granted = [];
  const rejected = [];
  for (const name of new Set(names)) {
    if (typeof name !== 'string' || !options.hasDefinition(name)) {
      rejected.push(Object.freeze({ name, reason: 'tool_unavailable' }));
      continue;
    }
    const candidateNames = new Set([...leases.keys(), name]);
    const capacity = capacityFor(candidateNames);
    const reason = capacity.names.length > capacity.limits.count ? 'schema_count_limit'
      : capacity.schemaBytes > capacity.limits.bytes ? 'schema_byte_limit' : null;
    if (reason) {
      rejected.push(Object.freeze({ name, reason }));
      continue;
    }
    const prior = leases.get(name);
    const sources = [...new Set([...(prior?.sources ?? []), source])].slice(-MAX_SOURCES);
    leases.delete(name);
    leases.set(name, Object.freeze({ remainingUses: Math.max(prior?.remainingUses ?? 0, uses), sources: Object.freeze(sources) }));
    granted.push(Object.freeze({ name, remaining_uses: leases.get(name).remainingUses, sources: leases.get(name).sources }));
  }
  return Object.freeze({ granted: Object.freeze(granted), rejected: Object.freeze(rejected) });
}

export function consumeWorkflowLease(leases, name) {
  const lease = leases.get(name);
  if (!lease) return;
  leases.delete(name);
  if (lease.remainingUses > 1) {
    // Why: reinsertion makes eviction order reflect actual use, not historical grant order.
    leases.set(name, Object.freeze({ remainingUses: lease.remainingUses - 1, sources: lease.sources }));
  }
}

function boundedSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source && source.length <= 64 ? source : 'runtime';
}
