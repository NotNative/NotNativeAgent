// SPDX-License-Identifier: Apache-2.0
// CLI operations for `nna opencode`: the foreground `serve` surface, the
// managed `run` runtime used by the wiring service's detached start, and the
// gateway-style lifecycle commands (status, start, stop, enable, disable)
// that install/remove the login startup script and OpenChamber environment.
import { join } from 'node:path';
import { startOpencodeServe } from './serve.js';
import { StructuredLog } from '../structured-log.js';
import { loadOpenCodeConfig } from './config.js';
import { openHostedBrowserTransport } from '../hosted-browser-client.js';
import {
  disableOpencodeService, enableOpencodeService, opencodeServiceStatus, removeRuntimePid, requireServiceRuntime,
  startOpencodeService, stopOpencodeService, writeRuntimePid,
} from './service.js';

const RUNTIME_LOG_FILE = 'runtime.ndjson';

/**
 * Ports a desktop OpenChamber may be listening on.
 *
 * Why a fixed list: the desktop application binds an ephemeral port for its own
 * UI, and it does not write that port anywhere NNA can read. The well-known ports
 * cover a daemon or CLI install, and a caller that knows the port passes it
 * through the environment instead. Probing is bounded — one cheap control call
 * per candidate, 2.5 s each — so a machine with no OpenChamber pays a few seconds
 * once per service start rather than a hang.
 */
const OPENCHAMBER_CANDIDATE_PORTS = Object.freeze([3000, 3001, 5173, 4096]);

export async function runOpencodeCommand(options, paths, scope = {}) {
  const diagnostics = scope.diagnostics ?? { write: () => undefined };
  switch (options.serveAction) {
    // Why two names: `run` is what the wiring service and login script call, and
    // `serve` is what a host spawning NNA as its OpenCode passes. One operation, so
    // a detached daemon and a spawned child cannot behave differently.
    case 'run': case 'serve': return runManagedService(options, paths, scope, diagnostics);
    case 'start': return startOpencodeService(options, paths, scope);
    case 'stop': return stopOpencodeService(options, paths, scope);
    case 'status': return opencodeServiceStatus(options, paths, scope);
    case 'enable': return enableOpencodeService(options, paths, scope);
    case 'disable': return disableOpencodeService(options, paths, scope);
    default:
      diagnostics.write('nna opencode: valid actions are: status, start, stop, enable, disable\n');
      return 2;
  }
}

// Why: the wiring service and the login startup script invoke this action;
// the managed runtime reads its fixed wire identity from the persisted
// opencode configuration instead of ad-hoc process state.
async function runManagedService(options, paths, scope, diagnostics) {
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  requireServiceRuntime(config);
  const logger = await new StructuredLog({ path: join(paths.logs, RUNTIME_LOG_FILE) }).initialize();
  // Why here: this is where the surface is actually served, and the pane binding
  // belongs to this process's run. A missing binding is an ordinary state — an
  // operator may run NNA without OpenChamber — so the surface serves without a
  // browser tool rather than refusing to start.
  //
  // Why the port probe: OpenChamber does not publish the port it listens on where
  // NNA can read it, so a binding is not always discoverable. Probing the ports a
  // desktop install uses is what finds the instance actually running, and it is
  // bounded: each candidate gets one cheap control call and a short timeout.
  const hostedBrowserTransport = await openHostedBrowserTransport({
    environment: scope.environment ?? process.env,
    ports: OPENCHAMBER_CANDIDATE_PORTS,
    ...(scope.fetcher ? { fetcher: scope.fetcher } : {}),
  }).catch(() => null);
  const runtime = await startOpencodeServe({
    paths, manifestPath: options.manifestPath ?? undefined,
    // Why the CLI wins over the config: a host that spawns NNA picks the port and
    // passes it, then waits for the handshake to name the URL it bound. Ignoring
    // the flag would bind the stored port and hand back an address the host is not
    // watching, which reads to it as a failed start.
    hostname: options.serveHostname ?? config.hostname,
    port: options.servePort ?? config.port,
    username: config.username,
    password: config.password,
    logger,
    ...(hostedBrowserTransport ? { hostedBrowserTransport } : {}),
    // Why a dedicated store root: sessions must be listed after a restart, and the
    // list comes from an index written into the store root. Sharing the product's
    // session directory would also make this surface discover — and offer to open —
    // every journal NNA has ever written for the TUI, the gateway and Telegram,
    // because they all use the same `session_` prefix and carry no surface marker.
    storeRoot: join(paths.opencode, 'sessions'),
  });
  // Why a spawned child writes no PID record: its lifetime is bounded by the host
  // that spawned it, not by a detached daemon's convention. A record left behind
  // would make the next `status` report a phantom server, and the next `start`
  // refuse to run because it believes one already does.
  if (!options.serveStdioLease) await writeRuntimePid(paths, process.pid, { port: runtime.port, url: runtime.url }, scope);
  diagnostics.write(`nna opencode: managed surface ready at ${runtime.url}\n`);
  await waitForShutdown(runtime, diagnostics, async () => {
    if (!options.serveStdioLease) await removeRuntimePid(paths);
  }, options.serveStdioLease);
}

/**
 * Waits until this process is told to stop.
 *
 * Why the stdin lease: a host that spawns NNA as its OpenCode stops it by closing
 * stdin, because a detached child on Windows has no signal to receive. Reading
 * stdin to end-of-file is therefore the stop request, and ignoring it would leave
 * a server the host cannot reclaim. Without the lease the process serves until a
 * signal, exactly as a daemon does.
 */
async function waitForShutdown(runtime, diagnostics, finish = async () => undefined, holdStdinLease = false) {
  let stopping = null;
  const stopOnce = (signal) => {
    if (stopping) return stopping;
    diagnostics.write(`nna opencode: ${signal} received; stopping\n`);
    stopping = (async () => {
      await runtime.stop();
      await finish();
    })().catch((error) => {
      diagnostics.write(`nna opencode: stop failed (${error.code ?? 'internal_failure'})\n`);
    });
    return stopping;
  };
  process.on('SIGINT', () => { void stopOnce('SIGINT').then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void stopOnce('SIGTERM').then(() => process.exit(0)); });
  if (holdStdinLease) {
    diagnostics.write('nna opencode: serving until stdin closes\n');
    await new Promise((resolve) => {
      process.stdin.on('end', resolve);
      process.stdin.on('close', resolve);
      // Why resume: a paused stream never emits 'end', so the lease would never fire.
      process.stdin.resume();
    });
    await stopOnce('stdin closed');
    process.exit(0);
  }
  diagnostics.write('nna opencode: serving until interrupted\n');
  await new Promise(() => { /* serve mode exits only via signal. */ });
}
