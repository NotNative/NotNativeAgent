// SPDX-License-Identifier: Apache-2.0
// CLI operations for `nna opencode`: the foreground `serve` surface, the
// managed `run` runtime used by the wiring service's detached start, and the
// gateway-style lifecycle commands (status, start, stop, enable, disable)
// that install/remove the login startup script and OpenChamber environment.
import { join } from 'node:path';
import { startOpencodeServe } from './serve.js';
import { StructuredLog } from '../structured-log.js';
import { loadOpenCodeConfig } from './config.js';
import {
  disableOpencodeService, enableOpencodeService, opencodeServiceStatus, removeRuntimePid, requireServiceRuntime,
  startOpencodeService, stopOpencodeService, writeRuntimePid,
} from './service.js';

const RUNTIME_LOG_FILE = 'runtime.ndjson';

export async function runOpencodeCommand(options, paths, scope = {}) {
  const diagnostics = scope.diagnostics ?? { write: () => undefined };
  switch (options.serveAction) {
    case 'serve': return serveForeground(options, paths, scope, diagnostics);
    case 'run': return runManagedService(options, paths, scope, diagnostics);
    case 'start': return startOpencodeService(options, paths, scope);
    case 'stop': return stopOpencodeService(options, paths, scope);
    case 'status': return opencodeServiceStatus(options, paths, scope);
    case 'enable': return enableOpencodeService(options, paths, scope);
    case 'disable': return disableOpencodeService(options, paths, scope);
    default:
      diagnostics.write('nna opencode: valid actions are: serve, status, start, stop, enable, disable\n');
      return 2;
  }
}

async function serveForeground(options, paths, scope, diagnostics) {
  const logger = await new StructuredLog({ path: join(paths.logs, RUNTIME_LOG_FILE) }).initialize();
  const credentials = serveCredentials();
  const runtime = await startOpencodeServe({
    paths, manifestPath: options.manifestPath,
    hostname: options.serveHostname ?? undefined,
    port: options.servePort ?? undefined,
    wiredVersion: options.advertiseVersion ?? undefined,
    password: credentials.password,
    username: credentials.username,
    logger,
  });
  scope?.output?.write(`nna: opencode surface ready at ${runtime.url}\n`);
  await waitForShutdown(runtime, diagnostics);
  return 0;
}

// Why: the wiring service and the login startup script invoke this action;
// the managed runtime reads its fixed wire identity from the persisted
// opencode configuration instead of ad-hoc process state.
async function runManagedService(options, paths, scope, diagnostics) {
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  requireServiceRuntime(config);
  const logger = await new StructuredLog({ path: join(paths.logs, RUNTIME_LOG_FILE) }).initialize();
  const runtime = await startOpencodeServe({
    paths, manifestPath: options.manifestPath ?? undefined,
    hostname: config.hostname,
    port: config.port,
    username: config.username,
    password: config.password,
    wiredVersion: options.advertiseVersion ?? undefined,
    logger,
  });
  await writeRuntimePid(paths, process.pid, { port: runtime.port, url: runtime.url }, scope);
  diagnostics.write(`nna opencode: managed surface ready at ${runtime.url}\n`);
  await waitForShutdown(runtime, diagnostics, () => removeRuntimePid(paths));
}

// Why: OpenChamber derives its Basic header from OPENCODE_SERVER_PASSWORD and
// OPENCODE_SERVER_USERNAME?.trim() with the default username as the fallback,
// so the foreground surface must bind the same environment-derived identity or
// a customized OPENCODE_SERVER_USERNAME authenticates against a name the
// server never expects and every proxied call is rejected with 401. The
// managed runtime instead binds the persisted configuration identity.
export function serveCredentials(environment = process.env) {
  return {
    password: environment.OPENCODE_SERVER_PASSWORD?.trim() || null,
    username: environment.OPENCODE_SERVER_USERNAME?.trim() || null,
  };
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
