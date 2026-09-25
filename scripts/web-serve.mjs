// SPDX-License-Identifier: Apache-2.0
/**
 * Web-only runner (user request: preview without the desktop shell).
 * Serves the built UI + full API from the P12a dist-server bundle, no
 * Electron. Envs honored by env.ts/ts (NOTNATIVE_PORT, NOTNATIVE_DIST_DIR
 * for the UI dist, NOTNATIVE_DATA_DIR, NOTNATIVE_HARNESS).
 */
import { startServer } from '../packages/electron/dist-server/server.mjs';

// `startServer` awaits managed-NNA readiness.  Handle that rejection here so
// the web-only entrypoint reports the same bounded startup failure as the
// source server entrypoint instead of relying on Node's unhandled-rejection
// policy.
startServer().catch((error) => {
  console.error(`NotNativeDesktop server failed to start: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
