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
import { upgradeAllowedForRequest, getUiAuthController } from './lib/auth/ui-auth.ts';
import { getPairingSessionStore } from './lib/auth/pairing-sessions.ts';
import { getRelayHostService } from './lib/relay/host-service.ts';
import { wireTunnelPlane } from './lib/tunnels/tunnel-startup.ts';
import { getMessageQueueRuntime } from './queue/queue-runtime.ts';
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
  // Relay host service (doc 08 §3.12): demand signals drive the lifecycle —
  // paired relay devices keep the host up; the 60 s poll also catches
  // headless pairing writes; the claim watcher arbitrates multi-instance
  // hosts. Registered BEFORE /api surfaces answer traffic is unnecessary:
  // the routes resolve the same singleton lazily.
  const relayService = getRelayHostService({
    demandSignals: [
      () => getUiAuthController().hasActiveRelayClients(),
      () => getPairingSessionStore().hasActiveRelaySession(), // §3.12: still-redeemable relay pairings
    ],
    localPort: ENV.port,
    platform: process.env.NOTNATIVE_RUNTIME ?? 'web',
    appVersion: ENV.version,
  });
  try {
    relayService.start();
  } catch (error) {
    console.warn(`relay service boot failed: ${String(error)}`);
  }
  // Tunnel plane (doc 08 §4): TTL re-clamp, singleton seeding, §4.7
  // startup tunnel (failures degrade to no tunnel and never abort boot).
  const tunnelPlane = wireTunnelPlane();
  // Message queue (doc 12 §D): the feed pump + reconcile beat run for the
  // process lifetime; routes resolve the same singleton lazily — a
  // smoky/test app router never holds the event loop open on its own.
  bootMessageQueue();
  console.log(`NotNativeDesktop server ready -> http://${ENV.host}:${ENV.port} (harness: ${ENV.harness})`);
  const shutdown = (): void => {
    // doc 07 section 4.8: stop the sweep, kill all PTYs, drop the WS server
    terminal.dispose();
    wiring.dispose();
    relayService.dispose();
    void tunnelPlane.dispose(); // §4.7: revoke artifacts, stop the provider controller
    getMessageQueueRuntime().dispose(); // doc 12 §D runtime owns timers/feed
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return { port: ENV.port };
}

const isDirectRun = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('server/index.ts');
if (isDirectRun) startServer();

function bootMessageQueue(): void {
  try {
    getMessageQueueRuntime();
  } catch (error) {
    console.warn(`message queue boot failed: ${String(error)}`);
  }
}
