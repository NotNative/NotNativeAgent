// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export function normalizeArgumentAliases(value, aliases) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const normalized = { ...value };
  for (const [canonical, alternatives] of Object.entries(aliases)) {
    const supplied = [canonical, ...alternatives].filter((name) => Object.hasOwn(normalized, name));
    if (supplied.length === 0) continue;
    const selected = normalized[supplied[0]];
    if (supplied.some((name) => normalized[name] !== selected)) {
      throw new ContractError('tool_schema_invalid',
        `conflicting aliases were supplied for argument "${canonical}": ${supplied.join(', ')}`);
    }
    normalized[canonical] = selected;
    for (const alternative of alternatives) delete normalized[alternative];
  }
  return normalized;
}
