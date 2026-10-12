// SPDX-License-Identifier: Apache-2.0
/**
 * NotNativeDesktop server entry.
 * Runs on Node 22+ with native TypeScript transformation enabled by launchers.
 * The Electron main process will import startServer() in-process (doc 09, P12).
 */
import { configureNativeHarness, type NativeHarnessOptions } from './harness/nna-supervised.ts';
import type { NativeUiIdentity } from './lib/auth/native-ui-auth.ts';
import type { NativeHealthProofIdentity } from './lib/auth/native-health-proof.ts';
import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { createApp } from './app.ts';
import { ENV, nativeServiceTerminalUnavailable } from './env.ts';
import { registerHarnessAdapter } from './harness/adapter.ts';
import { mockHarness } from './harness/mock/index.ts';
import { createNnaHarnessAdapter } from './harness/nna.ts';
import { guardLocalNnaHarness, resolveNnaCommand, startLocalNnaHarnessWithRetry, type LocalNnaHarness } from './harness/nna-local.ts';
import { upgradeAllowedForRequest, getUiAuthController, installNativeUiAuth } from './lib/auth/ui-auth.ts';
import { getPairingSessionStore } from './lib/auth/pairing-sessions.ts';
import { getRelayHostService } from './lib/relay/host-service.ts';
import { wireTunnelPlane } from './lib/tunnels/tunnel-startup.ts';
import { getMessageQueueRuntime } from './queue/queue-runtime.ts';
import { bootScheduledTasks, stopScheduledTasks } from './scheduled/scheduled-service.ts';
import { guardGoalAuditExchangePorts, NnaGoalSafetyRuntime } from './goals/nna-goal-runtime.ts';
import { runGoalAuditExchange } from './goals/nna-goal-auditor.ts';
import { createNnaGoalAuditPorts } from './goals/nna-goal-safety-ports.ts';
import { onSettingsWrite, readMergedSettings } from './lib/settings-store.ts';
import { createNnaContextRestorationPorts } from './context/nna-context-obligatory-ports.ts';
import { ContextObligatoryRuntime } from './context/context-obligatory-runtime.ts';
import { createTerminalRuntime } from './terminal/bootstrap.ts';
import { SessionAssistRuntime } from './session-assist/session-assist-runtime.ts';
import { createNnaSessionAssistPorts } from './session-assist/nna-session-assist.ts';
import { agentMemoryEnabled } from './project-context/agent-memory.ts';
import { BrowserControlBroker } from './preview/browser-control-broker.ts';
import { attachTerminalWebsocket } from './terminal/wire.ts';
import { attachDevTunnelWebsocket, freshDevServerPorts } from './preview/dev-tunnel.ts';
import { attachBrowserTabExecutor } from './preview/browser-tab-executor.ts';
import type { Server as HttpServer } from 'node:http';
import { createPushServices, attachPushNotifications } from './push/runtime.ts';

export async function startServer(options?: { nativeHarness?: NativeHarnessOptions; nativeAuth?: NativeUiIdentity;
  nativeHealthProof?: NativeHealthProofIdentity; desktopUpdater?: {
  check: () => Promise<{ available: boolean; currentVersion: string; version?: string | null; body?: string | null; date?: string | null }>;
  download: () => Promise<unknown>;
  install: () => Promise<unknown>;
  getInstallError?: () => string | null;
  clearInstallError?: () => void;
} }): Promise<{ port: number; browserControl: BrowserControlBroker; closed: Promise<void>; nativeAuth?: { issueTicket(): { ticket: string; expiresAt: string }; revoke(): void }; dispose(): void }> {
  if (options?.nativeHarness && !options.nativeAuth) throw new Error('Native harness requires native UI authentication');
  if (options?.nativeHealthProof && (!options.nativeAuth ||
    options.nativeHealthProof.installationId !== options.nativeAuth.installationId ||
    options.nativeHealthProof.dataId !== options.nativeAuth.dataId ||
    options.nativeHealthProof.generation !== options.nativeAuth.generation ||
    options.nativeHealthProof.origin !== options.nativeAuth.origin)) throw new Error('Native health proof identity differs');
  if (options?.nativeAuth && options.nativeAuth.origin !== new URL(`http://${ENV.host}:${ENV.port}`).origin) {
    throw new Error('Native UI origin must match the configured listener');
  }
  const nativeBinding = options?.nativeAuth ? installNativeUiAuth(options.nativeAuth) : undefined;
  const lifecycle = { attached: false, close: () => nativeBinding?.controller.close(), release: () => nativeBinding?.release() };
  let browserControl: BrowserControlBroker | undefined;
  let localNna: LocalNnaHarness | undefined;
  try {
    browserControl = new BrowserControlBroker();
    const browserCallbackSecret = randomBytes(32).toString('base64url');
    const browserCallback = options?.nativeHarness || process.env.NOTNATIVE_BROWSER_BRIDGE === 'disabled' ? undefined : {
      url: `http://127.0.0.1:${ENV.port}/api/browser-control/request`, token: browserCallbackSecret,
    };
    const agentToolCallbackSecret = randomBytes(32).toString('base64url');
    const agentToolCallback = !options?.nativeHarness && agentMemoryEnabled() ? {
      url: `http://127.0.0.1:${ENV.port}/api/agent-tool/callback`, token: agentToolCallbackSecret,
    } : undefined;
    localNna = options?.nativeHarness ? configureNativeHarness(options.nativeHarness)
      : await configureHarness(browserCallback, agentToolCallback);
    const running = await startConfiguredServer(localNna, browserControl, browserCallback ? browserCallbackSecret : undefined,
      agentToolCallback ? agentToolCallbackSecret : undefined, options?.desktopUpdater, lifecycle, options?.nativeHealthProof);
    const nativeAuth = nativeBinding?.controller.nativeHandle();
    return { ...running, ...(nativeAuth ? { nativeAuth: { issueTicket: nativeAuth.issueTicket, revoke: () => running.dispose() } } : {}) };
  } catch (error) {
    // If a later server subsystem (for example a port bind) rejects boot, the
    // child already authenticated to this process must not survive orphaned.
    lifecycle.close();
    if (!lifecycle.attached) lifecycle.release();
    localNna?.dispose();
    browserControl?.dispose();
    throw error;
  }
}

async function startConfiguredServer(localNna: LocalNnaHarness | undefined, browserControl: BrowserControlBroker,
  browserCallbackSecret: string | undefined, agentToolCallbackSecret: string | undefined,
  desktopUpdater?: { check: () => Promise<{ available: boolean; currentVersion: string; version?: string | null; body?: string | null; date?: string | null }>;
    download: () => Promise<unknown>; install: () => Promise<unknown>; getInstallError?: () => string | null; clearInstallError?: () => void }, lifecycle?: { attached: boolean; close(): void; release(): void },
  nativeHealthProof?: NativeHealthProofIdentity):
  Promise<{ port: number; browserControl: BrowserControlBroker; closed: Promise<void>; dispose(): void }> {
  // Terminal subsystem (doc 07): routes on the app + WS on the HTTP server.
  const terminal = createTerminalRuntime();
  const push = createPushServices();
  const app = createApp({ terminal, harnessPort: localNna ? Number(new URL(localNna.endpoint).port) : undefined,
    push, ...(nativeHealthProof ? { nativeHealthProof } : {}),
    ...(desktopUpdater ? { desktopUpdater } : {}),
    ...(localNna && browserCallbackSecret ? { browserControl, browserCallbackSecret } : {}),
    previewProxyPorts: freshDevServerPorts,
    ...(agentToolCallbackSecret === undefined ? {} : { agentToolCallbackSecret }) });
  const server = serve({ fetch: app.fetch, hostname: ENV.host, port: ENV.port });
  const closed = new Promise<void>((resolve) => server.once('close', resolve));
  if (lifecycle) {
    lifecycle.attached = true;
    server.once('close', () => { lifecycle.close(); lifecycle.release(); });
  }
  // Node reports EADDRINUSE and similar bind failures through an asynchronous
  // error event. Wait here so the caller can stop its already-owned NNA child.
  try { await awaitServerListening(server as HttpServer); }
  catch (error) {
    lifecycle?.close();
    server.close();
    if (!server.listening) lifecycle?.release();
    throw error;
  }
  let wiring: ReturnType<typeof attachTerminalWebsocket> | undefined;
  let relayService: ReturnType<typeof startRelayHostService> | undefined;
  let tunnelPlane: ReturnType<typeof wireTunnelPlane> | undefined;
  let goalSafety: ReturnType<typeof bootAutomation> | undefined;
  let devTunnelWiring: ReturnType<typeof attachDevTunnelWebsocket> | undefined;
  let browserTabWiring: ReturnType<typeof attachBrowserTabExecutor> | undefined;
  let stopPush: (() => void) | undefined;
  try {
    // E-07-3 slot: the ui/tunnel composed predicate backs the terminal
    // upgrade gate (loopback stays enforced in the wire layer).
    wiring = attachTerminalWebsocket(server as HttpServer, terminal,
      (url, headers, method) => !nativeServiceTerminalUnavailable()
        && upgradeAllowedForRequest(url, headers, method));
    devTunnelWiring = attachDevTunnelWebsocket(server as HttpServer, { availablePorts: freshDevServerPorts });
    browserTabWiring = attachBrowserTabExecutor(server as HttpServer, browserControl);
    terminal.startSweep();
    relayService = startRelayHostService();
    // Tunnel plane (doc 08 §4): TTL re-clamp, singleton seeding, §4.7
    // startup tunnel (failures degrade to no tunnel and never abort boot).
    tunnelPlane = wireTunnelPlane();
    // Message queue (§D) + scheduled tasks (§C) run for the process lifetime;
    // routes resolve the same singletons lazily — tests never hold timers.
    goalSafety = bootAutomation();
    stopPush = attachPushNotifications(push, getMessageQueueRuntime().feed);
  } catch (error) {
    stopPush?.(); push.delivery.dispose();
    // A failure after bind must not leave a listener accepting requests with
    // its authenticated NNA child already stopped by the outer boot guard.
    rollbackServerStart(server as HttpServer, terminal, wiring, relayService, tunnelPlane, goalSafety,
      devTunnelWiring);
    throw error;
  }
  console.log(`NotNativeDesktop server ready -> http://${ENV.host}:${ENV.port} (harness: ${ENV.harness})`);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    lifecycle?.close();
    process.removeListener('SIGINT', dispose);
    process.removeListener('SIGTERM', dispose);
    stopPush?.(); push.delivery.dispose();
    terminal.dispose(); // doc 07 section 4.8: stop sweep, kill all PTYs, drop the WS server
    browserControl.dispose();
    wiring.dispose();
    devTunnelWiring?.dispose();
    browserTabWiring?.dispose();
    relayService.dispose();
    void tunnelPlane.dispose(); // §4.7: revoke artifacts, stop the provider controller
    goalSafety?.dispose();
    getMessageQueueRuntime().dispose(); // doc 12 §D runtime owns timers/feed
    stopScheduledTasks(); // doc 12 §C runtime owns due timers + queue
    localNna?.dispose();
    server.close();
    (server as HttpServer).closeAllConnections?.();
  };
  process.once('SIGINT', dispose);
  process.once('SIGTERM', dispose);
  return { port: ENV.port, browserControl, closed, dispose }; // shell and authenticated child callback share one broker
}

function rollbackServerStart(server: HttpServer, terminal: ReturnType<typeof createTerminalRuntime>,
  wiring?: ReturnType<typeof attachTerminalWebsocket>, relay?: ReturnType<typeof startRelayHostService>,
  tunnel?: ReturnType<typeof wireTunnelPlane>, goal?: ReturnType<typeof bootAutomation>,
  devTunnel?: ReturnType<typeof attachDevTunnelWebsocket>): void {
  server.close();
  terminal.dispose();
  wiring?.dispose();
  relay?.dispose();
  void tunnel?.dispose();
  goal?.dispose();
  devTunnel?.dispose();
}

/** Demand signals drive the relay lifecycle; routes resolve this singleton lazily. */
function startRelayHostService() {
  const relayService = getRelayHostService({
    demandSignals: [
      () => getUiAuthController().hasActiveRelayClients(),
      () => getPairingSessionStore().hasActiveRelaySession(),
    ],
    localPort: ENV.port,
    platform: process.env.NOTNATIVE_RUNTIME ?? 'web',
    appVersion: ENV.version,
  });
  try { relayService.start(); }
  catch (error) { console.warn(`relay service boot failed: ${String(error)}`); }
  return relayService;
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

async function configureHarness(browserCallback: { url: string; token: string } | undefined,
  agentToolCallback?: { url: string; token: string }): Promise<LocalNnaHarness | undefined> {
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
  const local = await startLocalNnaHarnessWithRetry({
    command: launch.command, commandArguments: launch.arguments, dataRoot: launch.dataRoot,
    browserCallback, agentToolCallback,
  });
  await local.ensurePrimaryWorkspaceId();
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

function bootAutomation(): { dispose(): void } | null {
  bootMessageQueue();
  bootScheduledTasks();
  const disposers = [bootContextObligatory(), bootGoalSafety(), bootSessionAssist()].filter((disposer): disposer is {
    dispose(): void;
  } => disposer !== null);
  if (disposers.length === 0) return null;
  return {
    dispose() {
      for (const disposer of [...disposers].reverse()) disposer.dispose();
    },
  };
}

function bootSessionAssist(): { dispose(): void } | null {
  try {
    const feed = getMessageQueueRuntime().feed;
    const ports = createNnaSessionAssistPorts();
    const enabled = () => {
      const settings = readMergedSettings('web');
      return settings.sessionRecapEnabled !== false || settings.sessionSuggestionEnabled !== false;
    };
    const runtime = new SessionAssistRuntime(feed, ports, enabled);
    runtime.start();
    const unsubscribe = onSettingsWrite((keys) => {
      if (keys.includes('sessionRecapEnabled') || keys.includes('sessionSuggestionEnabled')) runtime.settingsChanged();
    });
    return { dispose() { unsubscribe(); runtime.dispose(); } };
  } catch (error) {
    console.warn(`session assist boot failed: ${String(error)}`);
    return null;
  }
}

/** Re-apply pinned messages and pending project knowledge after compaction. */
function bootContextObligatory(): { dispose(): void } | null {
  try {
    const ports = createNnaContextRestorationPorts();
    const runtime = new ContextObligatoryRuntime(getMessageQueueRuntime().feed, ports,
      (sessionId, directory) => ports.recordKnowledgeDelivered(sessionId, directory));
    runtime.start();
    return { dispose() { runtime.dispose(); ports.dispose(); } };
  } catch (error) {
    console.warn(`context restoration boot failed: ${String(error)}`);
    return null;
  }
}

/** Real-harness clients; the goal exchange may dispatch a bounded continuation prompt. */
function bootGoalSafety(): { dispose(): void } | null {
  if (ENV.harness !== 'nna') return null;
  try {
    const ports = createNnaGoalAuditPorts();
    const runtime = new NnaGoalSafetyRuntime(getMessageQueueRuntime().feed, ports,
      () => readMergedSettings('web').sessionGoalEnabled === true,
      (ready, sessionId, directory, isCurrent) =>
        runGoalAuditExchange(guardGoalAuditExchangePorts(ports, isCurrent),
          ready, sessionId, directory).then(() => undefined));
    runtime.start();
    const unsubscribe = onSettingsWrite((keys) => {
      if (keys.includes('sessionGoalEnabled')) runtime.settingsChanged();
    });
    return { dispose() { unsubscribe(); runtime.dispose(); } };
  } catch (error) {
    console.warn(`goal safety boot failed: ${String(error)}`);
    return null;
  }
}
