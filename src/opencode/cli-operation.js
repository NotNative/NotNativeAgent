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
    case 'run': return runManagedService(options, paths, scope, diagnostics);
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
    hostname: config.hostname,
    port: config.port,
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
  await writeRuntimePid(paths, process.pid, { port: runtime.port, url: runtime.url }, scope);
  diagnostics.write(`nna opencode: managed surface ready at ${runtime.url}\n`);
  await waitForShutdown(runtime, diagnostics, () => removeRuntimePid(paths));
}

async function waitForShutdown(runtime, diagnostics, finish = async () => undefined) {
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
  diagnostics.write('nna opencode: serving until interrupted\n');
  await new Promise(() => { /* serve mode exits only via signal. */ });
}
