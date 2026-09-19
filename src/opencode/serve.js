// SPDX-License-Identifier: Apache-2.0
// `nna opencode serve`: composes the OpenCode-compatible server over a live
// session workspace, binds it, and emits the exact OpenCode stdout handshake
// that OpenChamber's launcher parses.
import { createOpenCodeSessionWorkspace } from './sessions.js';
import { OpenCodeCompatServer } from './server.js';
import {
  WIRED_OPENCODE_VERSION, HANDSHAKE_LINE_PREFIX, DEFAULT_SERVE_HOSTNAME, DEFAULT_SERVE_PORT, DEFAULT_BASIC_USERNAME,
} from './version.js';

const NON_INTERACTIVE_INPUT = Object.freeze({
  async *[Symbol.asyncIterator]() { throw Object.assign(new Error('non_interactive'), { code: 'opencode_manifest_required' }); },
});

export async function startOpencodeServe(options = {}) {
  const wiredVersion = options.wiredVersion ?? WIRED_OPENCODE_VERSION;
  const config = await resolveScenarioConfiguration(options);
  const workspace = createOpenCodeSessionWorkspace({
    config, wiredVersion,
    logger: options.logger ?? null,
    storeRoot: options.storeRoot, reviewerRoot: options.reviewerRoot,
    directory: options.directory,
    scheduler: options.scheduler, secretBroker: options.secretBroker,
    providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
  });
  const server = new OpenCodeCompatServer({
    port: options.port ?? DEFAULT_SERVE_PORT,
    hostname: options.hostname ?? DEFAULT_SERVE_HOSTNAME,
    wiredVersion,
    registry: workspace.registry,
    operations: workspace.operations,
    bus: workspace.bus,
    logger: options.logger ?? null,
    password: options.password ?? null,
    username: options.username ?? DEFAULT_BASIC_USERNAME,
  });
  const bound = await server.start();
  const hostname = options.hostname ?? DEFAULT_SERVE_HOSTNAME;
  const line = `${HANDSHAKE_LINE_PREFIX}http://${hostname}:${bound.port}`;
  (options.stdout ?? process.stdout).write(`${line}\n`);
  if (options.handshakeSink) await options.handshakeSink(line);
  return new OpencodeServeRuntime({
    server, workspace, config, url: `http://${hostname}:${bound.port}`, port: bound.port, wiredVersion, stdout: options.stdout ?? null,
  });
}

async function resolveScenarioConfiguration(options) {
  if (options.config && typeof options.config === 'object') return options.config;
  if (options.manifestPath) {
    const { loadManifest } = await import('../cli-options.js');
    return loadManifest(options.manifestPath);
  }
  const { loadStartupManifestDocument } = await import('../onboarding.js');
  const { resolveManifest } = await import('../config.js');
  const document = await loadStartupManifestDocument({
    paths: options.paths, environment: process.env, input: NON_INTERACTIVE_INPUT,
    discover: () => null,
  });
  return resolveManifest(document);
}

export class OpencodeServeRuntime {
  constructor({ server, workspace, config, url, port, wiredVersion, stdout }) {
    this.server = server;
    this.workspace = workspace;
    this.config = config;
    this.url = url;
    this.port = port;
    this.wiredVersion = wiredVersion;
    this.stdout = stdout;
    this.closed = false;
  }

  diagnostics() { return this.server.diagnostics(); }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.workspace.registry.list()]) {
      try { await this.workspace.operations.remove(record.id); } catch { /* stop is best-effort */ }
    }
    await this.server.stop();
    this.workspace.bus.close();
  }
}

