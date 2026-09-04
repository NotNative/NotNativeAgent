// SPDX-License-Identifier: Apache-2.0
import { checkForUpdate } from './update-service.js';
import { ensureUserDataPaths, VERSION } from './product.js';

try {
  const paths = await ensureUserDataPaths();
  const result = await checkForUpdate({ statePath: paths.updateState, currentVersion: VERSION });
  if (result.status === 'unavailable') process.exitCode = 1;
} catch {
  // Invariant: the parent observes failure through exit status without exposing payloads.
  process.exitCode = 1;
}
