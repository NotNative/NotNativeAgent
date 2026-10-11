// SPDX-License-Identifier: Apache-2.0
/** Installed NND service entrypoint: the NNA-supervised GUI door only.
 *
 *  Execution guide 02 L4 retires the production managed-child path: NNA
 *  launches this entry with `--supervised` and owns bootstrap, capability
 *  renewal, and lifecycle. The historical managed port mode has no
 *  production caller; accepting it would create a second writer for the
 *  migrated NND state. Source development stays in `scripts/dev.mjs`,
 *  explicitly isolated from installed state. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function runInstalledService(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--supervised') {
    throw new Error('installed NND service runs only under NNA supervision: serve-installed.mjs --supervised');
  }
  const { runSupervisedService } = await import('./serve-supervised.mjs');
  return runSupervisedService();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runInstalledService().catch((error) => {
    console.error(`NND installed service failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
