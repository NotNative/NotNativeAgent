// SPDX-License-Identifier: Apache-2.0
// CLI operation for `nna opencode serve`: resolves the serve surface runtime,
// wires lifecycle cleanup, and blocks until the process is signalled.
import { join } from 'node:path';
import { startOpencodeServe } from './serve.js';
import { StructuredLog } from '../structured-log.js';

const RUNTIME_LOG_FILE = 'runtime.ndjson';

export async function runOpencodeCommand(options, paths, scope = {}) {
  const diagnostics = scope.diagnostics ?? { write: () => undefined };
  if (options.serveAction !== 'serve') {
    diagnostics.write('nna opencode: valid actions are: serve\n');
    return 2;
  }
  const logger = await new StructuredLog({ path: join(paths.logs, RUNTIME_LOG_FILE) }).initialize();
  const runtime = await startOpencodeServe({
    paths, manifestPath: options.manifestPath,
    hostname: options.serveHostname ?? undefined,
    port: options.servePort ?? undefined,
    wiredVersion: options.advertiseVersion ?? undefined,
    password: sanitizedPassword(),
    logger,
  });
  scope.output?.write(`nna: opencode surface ready at ${runtime.url}\n`);
  await waitForShutdown(runtime, diagnostics);
  return 0;
}

function sanitizedPassword() {
  const value = process.env.OPENCODE_SERVER_PASSWORD?.trim();
  return value ? value : null;
}

async function waitForShutdown(runtime, diagnostics) {
  let stopping = null;
  const stopOnce = (signal) => {
    if (stopping) return stopping;
    diagnostics.write(`nna opencode: ${signal} received; stopping\n`);
    stopping = (async () => { await runtime.stop(); })().catch((error) => {
      diagnostics.write(`nna opencode: stop failed (${error.code ?? 'internal_failure'})\n`);
    });
    return stopping;
  };
  process.on('SIGINT', () => { void stopOnce('SIGINT').then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void stopOnce('SIGTERM').then(() => process.exit(0)); });
  diagnostics.write('nna opencode: serving until interrupted\n');
  await new Promise(() => { /* OpenCode serve mode exits only via signal. */ });
}
