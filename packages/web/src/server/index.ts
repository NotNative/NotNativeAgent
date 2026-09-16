// SPDX-License-Identifier: Apache-2.0
/**
 * NotNativeDesktop server entry.
 * Runs on Node ≥22.18 with native TypeScript execution (erasable syntax only).
 * The Electron main process will import startServer() in-process (doc 09, P12).
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { ENV } from './env.ts';
import { registerHarnessAdapter } from './harness/adapter.ts';
import { mockHarness } from './harness/mock/index.ts';

export function startServer(): { port: number } {
  if (ENV.harness !== 'nna') {
    // NOTNATIVE_HARNESS=nna wires the NotNativeAgent adapter here (seam is ready)
    registerHarnessAdapter(mockHarness);
  }
  const app = createApp();
  const server = serve({ fetch: app.fetch, hostname: ENV.host, port: ENV.port });
  console.log(`NotNativeDesktop server ready → http://${ENV.host}:${ENV.port} (harness: ${ENV.harness})`);
  return { port: ENV.port };
}

const isDirectRun = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('server/index.ts');
if (isDirectRun) startServer();
