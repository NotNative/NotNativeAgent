// SPDX-License-Identifier: Apache-2.0
// The managed OpenCode worker composes the OpenCode-compatible server over a
// live session workspace, binds it, and emits the exact OpenCode stdout
// handshake that OpenChamber's launcher parses.
import { createOpenCodeSessionWorkspace } from './sessions.js';
import { restorePersistedSessions } from './session-restore.js';
import { OpenCodeCompatServer } from './server.js';
import { bindUrl } from './config.js';
import { OpenCodeProviderSettings } from './provider-settings.js';
import { FairScheduler } from '../provider/fair-scheduler.js';
import { LegacyArchive } from './legacy-archive.js';
import { configureEviction, reattachEvictedSession, stopEviction } from './session-eviction.js';
import { resolveManifest } from '../config.js';
import { userDataPaths } from '../product.js';
import { watchProviderSettings } from './provider-watch.js';
import {
  WIRED_OPENCODE_VERSION, HANDSHAKE_LINE_PREFIX, DEFAULT_SERVE_HOSTNAME, DEFAULT_SERVE_PORT, DEFAULT_BASIC_USERNAME,
  resolveWiredOpenCodeVersion,
} from './version.js';

const NON_INTERACTIVE_INPUT = Object.freeze({
  async *[Symbol.asyncIterator]() { throw Object.assign(new Error('non_interactive'), { code: 'opencode_manifest_required' }); },
});

export async function startOpencodeServe(options = {}) {
  // Why resolved per boot: the reported target must stay at or above npm's latest
  // published OpenCode contract, or OpenChamber's toast announces the server forever.
  const wiredVersion = options.wiredVersion ?? await resolveWiredOpenCodeVersion();
  const providerSettings = options.providerSettings ?? (!options.config && !options.manifestPath
    ? new OpenCodeProviderSettings({ root: (options.paths ?? userDataPaths()).opencode }) : null);
  const config = providerSettings ? options.config ?? resolveManifest({ provider: {
    id: 'unconfigured', endpoint: 'http://127.0.0.1:9/v1', model: 'unconfigured', trust_zone: 'loopback',
  } }) : await resolveScenarioConfiguration(options);
  // Why one scheduler for the whole surface: conversations on the same provider route
  // must share admission capacity, or three prompted conversations queue at the
  // provider invisibly. A caller that supplies its own scheduler keeps ownership.
  const scheduler = options.scheduler ?? new FairScheduler({
    limit: config.limits.providerConcurrency, maxQueued: config.limits.providerQueueLimit,
  });
  const workspace = createOpenCodeSessionWorkspace({
    config, wiredVersion, logger: options.logger ?? null,
    storeRoot: options.storeRoot, reviewerRoot: options.reviewerRoot, directory: options.directory,
    ...(options.skillRoots ? { skillRoots: options.skillRoots } : {}),
    scheduler, secretBroker: providerSettings?.secretBroker ?? options.secretBroker, providerSettings,
    providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
    // Why threaded here: a conversation shown by a hosting surface drives that
    // pane, resolved once per surface so every conversation shares one binding.
    ...(options.hostedBrowserTransport ? { hostedBrowserTransport: options.hostedBrowserTransport } : {}),
    archive: options.archive ?? null,
    reattachEvicted: (id) => reattachEvictedSession(
      workspace.core, { storeRoot: options.storeRoot, operations: workspace.operations }, id),
  });  // Why eviction: an idle conversation should not hold three durable file handles;
  // the sweep shuts idle engines down while the durable index and the registry's
  // dormant record keep the conversation listed and re-attachable.
  configureEviction(workspace.core, { idleMs: options.idleEvictionMs ?? 0 });
  const server = new OpenCodeCompatServer({
    port: options.port ?? DEFAULT_SERVE_PORT, hostname: options.hostname ?? DEFAULT_SERVE_HOSTNAME, wiredVersion,
    registry: workspace.registry, operations: workspace.operations, bus: workspace.bus, v2: workspace.v2,
    // Why passed: surface diagnostics report the shared scheduler's per-route held
    // state, so a saturated provider is distinguishable from a broken one.
    scheduler,
    directory: options.directory ?? config.workspaceRoot ?? process.cwd(),
    config, providerSettings,
    logger: options.logger ?? null,
    password: options.password ?? null,
    username: options.username ?? DEFAULT_BASIC_USERNAME,
  });
  const bound = await server.start();
  // Why restore before the handshake: OpenChamber starts, lists sessions, and only
  // then may a client open one, so restored history must exist by the time the
  // launcher hands the URL over. A skipped session never blocks boot.
  const { restored, skipped } = await restorePersistedSessions(workspace, options);
  const stopWatching = providerSettings ? watchProviderSettings(providerSettings, workspace.v2.events,
    options.directory ?? config.workspaceRoot, options.logger) : () => {};  const url = bindUrl({ hostname: options.hostname ?? DEFAULT_SERVE_HOSTNAME, port: bound.port });
  const line = `${HANDSHAKE_LINE_PREFIX}${url}`;
  (options.stdout ?? process.stdout).write(`${line}\n`);
  if (options.handshakeSink) await options.handshakeSink(line);
  return new OpencodeServeRuntime({
    server, workspace, config, url, port: bound.port, wiredVersion, stdout: options.stdout ?? null, stopWatching,
    restoreSummary: { restored: restored.length, skipped: skipped.length },
    archive: workspace.archive ?? options.archive ?? null,
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
  constructor({ server, workspace, config, url, port, wiredVersion, stdout, stopWatching, restoreSummary, archive }) {
    this.server = server;
    this.workspace = workspace;
    this.config = config;
    this.url = url;
    this.port = port;
    this.wiredVersion = wiredVersion;
    this.stdout = stdout;
    this.stopWatching = stopWatching;
    // Why exposed: the managed runtime logs it, so an operator can see from the
    // console record how many conversations came back and how many were skipped.
    this.restoreSummary = restoreSummary ?? { restored: 0, skipped: 0 };
    this.closed = false;
  }

  diagnostics() { return this.server.diagnostics(); }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    stopEviction(this.workspace.core);
    for (const record of [...this.workspace.registry.list()]) {
      // Invariant: stored sessions are keyed by ocId; the wire Session shape's id
      // never reaches removal, and a failed removal would leak the engine's
      // telemetry worker forever, so the surface stop must shut each one down.
      // Why `close` and not `remove`: stopping the process says nothing about
      // the conversation; removal would also erase the durable identity and
      // the next boot would not restore the session the GUI still lists.
      try { await this.workspace.operations.close(record.ocId ?? record.id); } catch { /* stop is best-effort */ }
    }
    await this.server.stop();
    this.workspace.bus.close();
    this.workspace.v2.close();
  }
}
