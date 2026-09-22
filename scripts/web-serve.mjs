// SPDX-License-Identifier: Apache-2.0
/**
 * Web-only runner (user request: preview without the desktop shell).
 * Serves the built UI + full API from the P12a dist-server bundle, no
 * Electron. Envs honored by env.ts/ts (NOTNATIVE_PORT, NOTNATIVE_DIST_DIR
 * for the UI dist, NOTNATIVE_DATA_DIR, NOTNATIVE_HARNESS).
 */
import { startServer } from '../packages/electron/dist-server/server.mjs';

startServer();
