// SPDX-License-Identifier: Apache-2.0
/** Test-only path helpers for the relay machine files. */
import { join as joinPath } from 'node:path';

export function relayLockPath(dataDir: string): string {
  return joinPath(dataDir, 'relay-host.lock');
}
