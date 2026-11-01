// SPDX-License-Identifier: Apache-2.0
import { posix, win32 } from 'node:path';
import { ContractError } from './ids.js';

// Why: Windows path identity is case-insensitive and must be resolved first;
// a raw string comparison can authorize a different file. The platform module
// is selected explicitly so the same rule can be tested on either host.
function pathModule(platform) { return platform === 'win32' ? win32 : posix; }

/** Compare two filesystem paths as the same identity on `platform`.
 *  Invariant: every caller that decides ownership or admission by a path uses
 *  this predicate, so resolve, case folding, and missing-input policy cannot
 *  drift between activation, workspace, and filesystem boundaries. */
export function pathIdentity(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length === 0 || right.length === 0) return false;
  const paths = pathModule(platform);
  const resolvedLeft = paths.resolve(left);
  const resolvedRight = paths.resolve(right);
  return platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/** Canonical map key for one filesystem path on `platform`. */
export function pathIdentityKey(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractError('path_identity_invalid', 'path identity requires a non-empty string');
  }
  const resolved = pathModule(platform).resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}
