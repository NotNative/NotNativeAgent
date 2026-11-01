// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';

/** A lowercase SHA-256 digest as written by `sha256Hex`. */
export const SHA256_HEX = /^[a-f0-9]{64}$/u;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
