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
import { createNnaHarnessAdapter } from './harness/nna.ts';
import { guardLocalNnaHarness, resolveNnaCommand, startLocalNnaHarness, type LocalNnaHarness } from './harness/nna-local.ts';
import { upgradeAllowedForRequest, getUiAuthController } from './lib/auth/ui-auth.ts';
import { getPairingSessionStore } from './lib/auth/pairing-sessions.ts';
import { getRelayHostService } from './lib/relay/host-service.ts';
import { wireTunnelPlane } from './lib/tunnels/tunnel-startup.ts';
import { getMessageQueueRuntime } from './queue/queue-runtime.ts';
import { bootScheduledTasks, stopScheduledTasks } from './scheduled/scheduled-service.ts';
import { NnaGoalSafetyRuntime } from './goals/nna-goal-runtime.ts';
import { runGoalAuditExchange } from './goals/nna-goal-auditor.ts';
import { createNnaGoalAuditPorts } from './goals/nna-goal-safety-ports.ts';
import { readMergedSettings } from './lib/settings-store.ts';
import { createTerminalRuntime } from './terminal/bootstrap.ts';
import { attachTerminalWebsocket } from './terminal/wire.ts';
import type { Server as HttpServer } from 'node:http';

export async function startServer(): Promise<{ port: number; dispose(): void }> {
  const localNna = await configureHarness();
  try {
    return await startConfiguredServer(localNna);
  } catch (error) {
    // If a later server subsystem (for example a port bind) rejects boot, the
    // child already authenticated to this process must not survive orphaned.
    localNna?.dispose();
    throw error;
  }
}

async function startConfiguredServer(localNna: LocalNnaHarness | undefined): Promise<{ port: number; dispose(): void }> {
  // Terminal subsystem (doc 07): routes on the app + WS on the HTTP server.
  const terminal = createTerminalRuntime();
  const app = createApp({ terminal });
  const server = serve({ fetch: app.fetch, hostname: ENV.host, port: ENV.port });
  // Node reports EADDRINUSE and similar bind failures through an asynchronous
  // error event. Wait here so the caller can stop its already-owned NNA child.
  await awaitServerListening(server as HttpServer);
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
  // Message queue (§D) + scheduled tasks (§C) run for the process lifetime;
  // routes resolve the same singletons lazily — tests never hold timers.
  const goalSafety = bootAutomation();
  console.log(`NotNativeDesktop server ready -> http://${ENV.host}:${ENV.port} (harness: ${ENV.harness})`);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    terminal.dispose(); // doc 07 section 4.8: stop sweep, kill all PTYs, drop the WS server
    wiring.dispose();
    relayService.dispose();
    void tunnelPlane.dispose(); // §4.7: revoke artifacts, stop the provider controller
    goalSafety?.dispose();
    getMessageQueueRuntime().dispose(); // doc 12 §D runtime owns timers/feed
    stopScheduledTasks(); // doc 12 §C runtime owns due timers + queue
    localNna?.dispose();
    server.close();
  };
  process.once('SIGINT', dispose);
  process.once('SIGTERM', dispose);
  return { port: ENV.port, dispose }; // P12a (NOTES/09 A.2): the in-process shell disposes through this same body
}

function awaitServerListening(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    const onListening = (): void => { server.off('error', onError); resolve(); };
    const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

async function configureHarness(): Promise<LocalNnaHarness | undefined> {
  if (ENV.harness !== 'nna') {
    registerHarnessAdapter(mockHarness);
    return undefined;
  }
  if (ENV.nnaMode === 'attach') {
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: ENV.nnaHarnessUrl, token: ENV.nnaIntegrationToken, principal: ENV.nnaPrincipal,
    }));
    return undefined;
  }
  const launch = await resolveNnaCommand({ command: ENV.nnaCommand });
  const local = await startLocalNnaHarness({
    command: launch.command, commandArguments: launch.arguments, dataRoot: launch.dataRoot, workspaceId: ENV.nnaWorkspaceId,
  });
  registerHarnessAdapter(guardLocalNnaHarness(createNnaHarnessAdapter({
    endpoint: local.endpoint, token: local.token, principal: local.principal,
  }), local));
  return local;
}

const isDirectRun = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('server/index.ts');
if (isDirectRun) void startServer().catch((error) => {
  // Startup diagnostics remain local; secrets from an NNA readiness line are never included.
  console.error(`NotNativeDesktop server failed to start: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});

function bootMessageQueue(): void {
  try {
    getMessageQueueRuntime();
  } catch (error) {
    console.warn(`message queue boot failed: ${String(error)}`);
  }
}

function bootAutomation(): NnaGoalSafetyRuntime | null {
  bootMessageQueue();
  bootScheduledTasks();
  return bootGoalSafety();
}

/** Real-harness clients; the goal exchange may dispatch a bounded continuation prompt. */
function bootGoalSafety(): NnaGoalSafetyRuntime | null {
  if (ENV.harness !== 'nna') return null;
  try {
    const ports = createNnaGoalAuditPorts();
    const runtime = new NnaGoalSafetyRuntime(getMessageQueueRuntime().feed, ports,
      () => readMergedSettings('web').sessionGoalEnabled === true,
      (ready, sessionId, directory) =>
        runGoalAuditExchange(ports, ready, sessionId, directory).then(() => undefined));
    runtime.start();
    return runtime;
  } catch (error) {
    console.warn(`goal safety boot failed: ${String(error)}`);
    return null;
  }
}
