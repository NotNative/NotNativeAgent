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
    // Invariant: an authenticated host manifest provides an exact surface with no soft limits.
    const reason = !capacity.names.includes(name) ? 'tool_unavailable'
      : capacity.limits && capacity.names.length > capacity.limits.count ? 'schema_count_limit'
        : capacity.limits && capacity.schemaBytes > capacity.limits.bytes ? 'schema_byte_limit' : null;
    if (reason) {
      rejected.push(Object.freeze({ name, reason }));
      continue;
    }
    const prior = leases.get(name);
    const sources = [...new Set([...(prior?.sources ?? []), source])].slice(-MAX_SOURCES);
    const renewOnUse = options.renewOnUse === true || prior?.renewOnUse === true;
    const renewalUses = renewOnUse ? Math.max(prior?.renewalUses ?? 0, prior?.remainingUses ?? 0, uses) : null;
    leases.delete(name);
    leases.set(name, Object.freeze({ remainingUses: Math.max(prior?.remainingUses ?? 0, uses), renewOnUse, renewalUses, sources: Object.freeze(sources) }));
    granted.push(Object.freeze({ name, remaining_uses: leases.get(name).remainingUses,
      ...(renewOnUse ? { renew_on_use: true, allowance_kind: 'other_sealed_calls' } : {}),
      sources: leases.get(name).sources }));
  }
  return Object.freeze({ granted: Object.freeze(granted), rejected: Object.freeze(rejected) });
}

export function consumeWorkflowLease(leases, name) {
  // Why: an exact-search lease stays hot while used but cools on other sealed calls.
  // Provider-surface assembly is not an actionable step and must not age any lease.
  for (const [leasedName, lease] of [...leases]) {
    if (leasedName !== name && !lease.renewOnUse) continue;
    const remainingUses = leasedName === name && lease.renewOnUse
      ? lease.renewalUses : lease.remainingUses - 1;
    if (remainingUses < 1) {
      leases.delete(leasedName);
    } else if (leasedName === name) {
      // Reinsertion reflects actual use without bypassing admission or host manifest limits.
      leases.delete(leasedName);
      leases.set(leasedName, Object.freeze({ ...lease, remainingUses }));
    } else {
      leases.set(leasedName, Object.freeze({ ...lease, remainingUses }));
    }
  }
}

function boundedSource(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  return source && source.length <= 64 ? source : 'runtime';
}
