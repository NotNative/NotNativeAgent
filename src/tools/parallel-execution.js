// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export async function boundedParallel(items, limit, operation) {
  let index = 0;
  let firstError = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length && firstError === null) {
      const item = items[index]; index += 1;
      try { await operation(item); }
      catch (error) { firstError ??= error; return; }
    }
  });
  // Why: an early rejection must not let sibling executions continue after the
  // parent step begins finalization or launch another queued tool after failure.
  await Promise.all(workers);
  if (firstError) throw firstError;
}

export function boundedParallelLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new ContractError('tool_concurrency_invalid', 'parallel tool limit must be between one and sixteen');
  }
  return value;
}
