// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const BATCHING_THRESHOLD = 100;
const MINIMUM_HEADROOM = 10;

export function retentionCompactionTarget(limit) {
  validateRetentionLimit(limit);
  if (limit < BATCHING_THRESHOLD) return limit;
  const headroom = Math.max(MINIMUM_HEADROOM, Math.floor(limit / 10));
  return Math.max(1, limit - headroom);
}

export function validateRetentionLimit(limit, maximum = 100_000) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new ContractError('retention_limit_invalid', `retention must be an integer from 1 through ${maximum}`);
  }
  return limit;
}
