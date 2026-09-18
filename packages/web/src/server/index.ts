// SPDX-License-Identifier: Apache-2.0
/**
 * NotNativeDesktop server entry.
 * Runs on Node 22+ with native TypeScript execution (erasable syntax only).
 * The Electron main process will import startServer() in-process (doc 09, P12).
 */
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { ENV } from './env.ts';
import { registerHarnessAdapter } from './harness/adapter.ts';
import { mockHarness } from './harness/mock/index.ts';
import { upgradeAllowedForRequest } from './lib/auth/ui-auth.ts';
import { createTerminalRuntime } from './terminal/bootstrap.ts';
import { attachTerminalWebsocket } from './terminal/wire.ts';
import type { Server as HttpServer } from 'node:http';

export function startServer(): { port: number } {
  if (ENV.harness !== 'nna') {
    // NOTNATIVE_HARNESS=nna wires the NotNativeAgent adapter here (seam is ready)
    registerHarnessAdapter(mockHarness);
  }
  // Terminal subsystem (doc 07): routes on the app + WS on the HTTP server.
  const terminal = createTerminalRuntime();
  const app = createApp({ terminal });
  const server = serve({ fetch: app.fetch, hostname: ENV.host, port: ENV.port });
  // E-07-3 slot: the ui/tunnel composed predicate backs the terminal
  // upgrade gate (loopback stays enforced in the wire layer).
  const wiring = attachTerminalWebsocket(
    server as HttpServer,
    terminal,
    (url, headers, method) => upgradeAllowedForRequest(url, headers, method),
  );
  terminal.startSweep();
  console.log(`NotNativeDesktop server ready -> http://${ENV.host}:${ENV.port} (harness: ${ENV.harness})`);
  const shutdown = (): void => {
    // doc 07 section 4.8: stop the sweep, kill all PTYs, drop the WS server
    terminal.dispose();
    wiring.dispose();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { port: ENV.port };
}

const isDirectRun = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('server/index.ts');
if (isDirectRun) startServer();
