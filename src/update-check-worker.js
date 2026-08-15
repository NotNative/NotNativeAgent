// SPDX-License-Identifier: Apache-2.0
import { checkForUpdate } from './update-service.js';
import { ensureUserDataPaths, VERSION } from './product.js';

try {
  const paths = await ensureUserDataPaths();
  await checkForUpdate({ statePath: paths.updateState, currentVersion: VERSION });
} catch {
  // This detached, stdio-free best-effort worker has no safe diagnostic channel. Interactive checks report failures.
}
