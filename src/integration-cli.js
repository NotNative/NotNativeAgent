// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants as fileConstants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { startIntegrationServer } from './integration-server.js';
import { withPrimaryRoute } from './provider/route-configuration.js';
import { createDesktopLocalIntegrationActivation, validateNnoIntegrationActivation } from './nno-integration-activation.js';
import { ProviderProfileStore } from './provider/profile-store.js';
import { SecretBroker } from './secret-broker.js';
import { LOCAL_SECRET_REALM } from './secret-contracts.js';
import { resolveManifest } from './config.js';
import { SessionEngine } from './engine.js';
import { DesktopEngineHost } from './desktop-engine-host.js';
import { createDesktopWorkspaceBindingResolver } from './desktop-workspace-selection.js';
import { desktopMcpInventory } from './desktop-mcp-inventory.js';
import { desktopSkillsInventory } from './desktop-skills-inventory.js';
import { desktopAgentInventory } from './desktop-agent-inventory.js';
import { SkillRegistry } from './skill-registry.js';
import { runtimeSkillRoots } from './startup-configuration.js';
import { workspaceIsTrusted } from './experience/trust.js';
import { consumeDesktopBrowserCallbackFromEnvironment } from './desktop-browser-tool.js';
import { createDesktopBrowserCallbackRegistry } from './desktop-browser-registration.js';
import { consumeDesktopAgentToolCallbackFromEnvironment } from './desktop-memory-tool.js';
import { assertRegisteredDesktopPackage, runDesktopPackageCommand } from './desktop-package.js';
import { createDesktopSetupRuntime } from './desktop-setup-runtime.js';
import { readDesktopSetupConfiguration, DESKTOP_CONFIGURATION_OPTIONS } from './desktop-setup-config.js';
import { acquireDesktopServiceLock } from './desktop-service-lock.js';
import { assertNoDesktopMigration } from './desktop-migration-storage.js';
import { assertNoDesktopInstallTransaction } from './desktop-install-storage.js';
import { assertNoDesktopInstallMarker } from './desktop-install-marker.js';

const INTEGRATION_MANIFEST_LIMIT = 1_048_576;

export async function runIntegrationCommand(args, paths, options = {}) {
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('integration_command_invalid', 'integration command supports serve');
  }
  const environment = options.environment ?? process.env;
  const activation = await validateNnoIntegrationActivation(environment.NNA_NNO_INSTALL_ROOT);
  return runActivatedIntegrationCommand(paths, options, activation, 'nno');
}

export async function runDesktopIntegrationCommand(args, paths, options = {}) {
  if (['start', 'stop', 'enable', 'disable', 'status'].includes(args[0])) {
    const { runDesktopLifecycleCommand } = await import('./desktop-lifecycle.js');
    return runDesktopLifecycleCommand(args, paths, options);
  }
  if (args[0] === 'service') {
    const { runDesktopServiceCommand } = await import('./desktop-service-cli.js');
    return runDesktopServiceCommand(args.slice(1), options);
  }
  if (args[0] === 'package') return runDesktopPackageCommand(args.slice(1), paths);
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('desktop_command_invalid', 'desktop command supports serve and package');
  }
  // Security: installed GUI launches identify their package root. A stale or
  // replaced package cannot silently start NNA's desktop integration.
  const environment = options.environment ?? process.env;
  if (environment.NNA_DESKTOP_INSTALL_ROOT !== undefined) {
    await assertRegisteredDesktopPackage(environment.NNA_DESKTOP_INSTALL_ROOT, paths);
  }
  const lease = process.platform === 'win32' ? await acquireDesktopServiceLock({ dataRoot: paths.root }) : null;
  try {
    await assertNoDesktopInstallMarker({ data_root: paths.root });
    await assertNoDesktopInstallTransaction({ data_root: paths.root });
    await assertNoDesktopMigration({ data_root: paths.root });
    const result = await runActivatedIntegrationCommand(paths, options, createDesktopLocalIntegrationActivation(), 'desktop');
    await lease?.close();
    return result;
  } catch (error) {
    // Invariant: a failed shutdown cannot release ownership while native writers may remain.
    if (!lease) throw error;
    if (!(error instanceof AggregateError) && !['desktop_setup_shutdown_timeout', 'desktop_setup_cleanup_failed', 'desktop_setup_host_failed'].includes(error.code)) {
      try { await lease.close(); }
      catch (cleanupError) {
        if (Object.isExtensible(error)) error.secondaryFailures = [...(error.secondaryFailures ?? []), cleanupError];
        else throw new AggregateError([error, cleanupError], 'desktop startup and lease cleanup failed.');
      }
    }
    throw error;
  }
}

async function runActivatedIntegrationCommand(paths, options, activation, owner) {
  const environment = options.environment ?? process.env;
  const token = randomBytes(32).toString('base64url');
  const instanceId = `nna_${randomUUID()}`;
  const broker = new SecretBroker({
    // The local desktop is an NNA operator surface and uses the same saved
    // provider bindings as the TUI. NNO deployments retain their own realm.
    realm: integrationSecretRealm(owner, activation.deploymentId),
    vaultPath: paths.secretVault, keyPath: paths.secretKey, auditPath: paths.secretAudit,
  });
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment, secretBroker: broker,
    ...(owner === 'desktop' ? { readEffectiveConfiguration: () => readDesktopSetupConfiguration(paths) } : {}) });
  const lifecycle = await createIntegrationLifecycle(paths, options, owner, broker, environment);
  const desktopEngineHost = lifecycle.getHost();
  let service;
  try {
    service = await startIntegrationServer({
      activation, token, instanceId, broker, providerStore, desktopEngineHost, desktopRuntime: lifecycle.runtime, desktopWorkspaceRoot: desktopEngineHost?.workspaceRoot,
      // Why: /path advertises the serving instance's NNA data inventory; the
      // server module must not silently re-derive it from a different NNA_HOME
      // than the one that created this process's lease and stores.
      dataPaths: paths,
      desktopBrowserCallbackRegistry: lifecycle.desktopBrowserCallbackRegistry, host: '127.0.0.1', port: 0,
    });
  } catch (error) {
    try { await lifecycle.close(); }
    catch (shutdownError) {
      if (owner === 'desktop') throw new AggregateError([error, shutdownError], 'desktop listener startup and runtime cleanup failed.');
      if (Object.isExtensible(error)) error.secondaryFailures = [...(error.secondaryFailures ?? []), shutdownError];
    }
    throw error;
  }
  const endpoint = `http://127.0.0.1:${service.address.port}`;
  const output = options.output ?? process.stdout;
  let failure = null;
  try {
    // Security: stdout is one readiness frame for the owning local process; the token is not logged.
    lifecycle.runtime?.start();
    output.write(`${JSON.stringify({ type: 'ready', protocol: activation.protocol, endpoint, instance_id: instanceId, token })}\n`);
    await waitForShutdown(options.signal, service.server);
  } catch (error) { failure = error; }
  try { await closeIntegrationLifecycle(service, lifecycle); } catch (error) {
    if (owner === 'desktop') failure = new AggregateError(failure ? [failure, error] : [error], 'desktop integration shutdown failed.');
    else if (!failure) failure = error;
    else if (Object.isExtensible(failure)) failure.secondaryFailures = [...(failure.secondaryFailures ?? []), error];
  }
  if (failure) throw failure;
  return { stopped: true };
}

async function closeIntegrationLifecycle(service, lifecycle) {
  if (lifecycle.runtime) {
    // Invariant: an admitted request retains its host until dispatch settles.
    // Close long-lived SSE connections before draining ordinary requests.
    service.stopAdmission();
    const results = await Promise.allSettled([closeDesktopListener(service), service.drain()]);
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'desktop integration shutdown failed.');
    await lifecycle.close();
    return;
  }
  let failure;
  try { await service.close(); } catch (error) { failure = error; }
  try { await lifecycle.close(); } catch (error) {
    if (!failure) failure = error;
    else if (Object.isExtensible(failure)) failure.secondaryFailures = [...(failure.secondaryFailures ?? []), error];
  }
  if (failure) throw failure;
}

function closeDesktopListener(service) {
  return new Promise((resolve, reject) => {
    let deadline;
    const force = setTimeout(() => {
      try { service.server.closeAllConnections(); }
      catch (error) { clearTimeout(deadline); reject(error); }
    }, 1000);
    deadline = setTimeout(() => {
      clearTimeout(force);
      reject(new ContractError('desktop_setup_shutdown_timeout', 'desktop listener shutdown exceeded its time bound.'));
    }, 16000);
    service.close().then(() => { clearTimeout(force); clearTimeout(deadline); resolve(); },
      (error) => { clearTimeout(force); clearTimeout(deadline); reject(error); });
  });
}

export async function createIntegrationLifecycle(paths, options, owner, broker, environment) {
  // Attach mode: the browser callback may also arrive after startup via the
  // registration route, so the env callback seeds a replaceable registry and
  // engines read its current value when they are created.
  const desktopBrowserCallbackRegistry = owner === 'desktop'
    ? createDesktopBrowserCallbackRegistry(consumeDesktopBrowserCallbackFromEnvironment(environment)) : null;
  const hostOptions = {
    ...options,
    // Security: only the local operator shares the TUI secret realm. NNO remains principal scoped.
    secretBroker: owner === 'desktop' ? broker : undefined,
    // Compat: direct callers may still pass a static callback; engines prefer
    // the registry's current value when one is present.
    desktopBrowserCallback: options.desktopBrowserCallback ?? null,
    desktopAgentToolCallback: owner === 'desktop' ? consumeDesktopAgentToolCallbackFromEnvironment(environment) : null,
    desktopBrowserCallbackRegistry,
  };
  if (owner !== 'desktop') {
    const host = await createIntegrationDesktopEngineHost(paths, hostOptions);
    return { getHost: () => host, close: () => host.shutdown(), runtime: undefined, desktopBrowserCallbackRegistry };
  }
  const runtime = createDesktopSetupRuntime({
    ...(options.activationTimeoutMs === undefined ? {} : { activationTimeoutMs: options.activationTimeoutMs }),
    loadConfiguration: (signal) => readDesktopSetupConfiguration(paths, signal),
    createHost: (preparedConfig, { signal }) => createIntegrationDesktopEngineHost(paths, { ...hostOptions, preparedConfig, setupSignal: signal }),
  });
  return { getHost: () => runtime.getHost(), close: () => runtime.close(), runtime, desktopBrowserCallbackRegistry };
}

export function integrationSecretRealm(owner, deploymentId) {
  return owner === 'desktop' ? LOCAL_SECRET_REALM : `${owner}:${deploymentId}`;
}

export async function createIntegrationDesktopEngineHost(paths, options = {}) {
  options.setupSignal?.throwIfAborted();
  const configOptions = DESKTOP_CONFIGURATION_OPTIONS;
  const config = options.preparedConfig ?? resolveManifest(await readIntegrationManifest(join(paths.config, 'manifest.json')), configOptions);
  let activeConfig = config;
  const trusted = typeof paths.trustedWorkspaces === 'string'
    ? await workspaceIsTrusted(paths.trustedWorkspaces, config.workspaceRoot) : false;
  const skillRoots = options.skillRoots ?? runtimeSkillRoots(paths, {
    trusted, skillRoot: join(config.workspaceRoot, '.nna', 'skills'),
  });
  const host = new DesktopEngineHost({
    primaryWorkspaceBinding: createDesktopWorkspaceBindingResolver(config.workspaceRoot, options.workspaceAdmissionService),
    catalogPath: config.persistence === 'durable' ? join(paths.sessions, 'desktop-contexts.json') : null,
    createEngine: (input) => createSelectedDesktopEngine(paths, options, config, () => activeConfig, trusted, input),
  });
  host.workspaceRoot = config.workspaceRoot;
  // Security: expose only the configured route identity to the desktop browser, never provider credentials or endpoints.
  host.desktopModel = Object.freeze({ providerID: config.routes.primary.providerId, modelID: config.routes.primary.model });
  host.desktopMcpInventory = desktopMcpInventory(config);
  host.desktopAgentInventory = desktopAgentInventory(config);
  host.providerRoutingPending = (latest) => !isDeepStrictEqual(activeConfig.providerProfiles, latest.providerProfiles)
    || !isDeepStrictEqual(activeConfig.routes, latest.routes);
  host.activateProviderRoute = async () => {
    // Compatibility: legacy NNO/direct hosts retain their original user-only configuration scope.
    const latest = options.preparedConfig ? await readDesktopSetupConfiguration(paths)
      : resolveManifest(await readIntegrationManifest(join(paths.config, 'manifest.json')), configOptions);
    if (latest.workspaceRoot !== config.workspaceRoot || latest.persistence !== config.persistence) {
      throw new ContractError('desktop_manifest_invalid', 'desktop provider activation cannot change workspace or persistence scope');
    }
    activeConfig = Object.freeze({ ...activeConfig, providerProfiles: latest.providerProfiles, routes: latest.routes });
    const route = activeConfig.routes.primary;
    host.desktopModel = Object.freeze({ providerID: route.providerId, modelID: route.model });
    host.desktopAgentInventory = desktopAgentInventory(activeConfig);
    return host.desktopModel;
  };
  // A newly created session discovers these same roots at initialization.
  // Read again per request so the UI does not freeze a startup-only catalog.
  host.readDesktopSkillsInventory = async () => {
    const skills = new SkillRegistry({ roots: skillRoots });
    try { await skills.initialize(); }
    catch { throw new ContractError('desktop_skills_unavailable', 'NNA skill discovery is unavailable'); }
    return desktopSkillsInventory(skills.catalog());
  };
  return initializeIntegrationHost(host, options.setupSignal);
}

async function createSelectedDesktopEngine(paths, options, startupConfig, activeConfig, startupTrusted, input) {
  const selectedRoot = input.workspaceBinding?.configured_root ?? activeConfig().workspaceRoot;
  const selectedTrusted = selectedRoot === startupConfig.workspaceRoot ? startupTrusted
    : typeof paths.trustedWorkspaces === 'string'
      ? await workspaceIsTrusted(paths.trustedWorkspaces, selectedRoot) : false;
  const selectedSkillRoots = options.skillRoots ?? runtimeSkillRoots(paths, {
    trusted: selectedTrusted, skillRoot: join(selectedRoot, '.nna', 'skills'),
  });
  const routed = input.modelRoute
    ? withPrimaryRoute(activeConfig(), input.modelRoute.providerId, input.modelRoute.model).config : activeConfig();
  return new SessionEngine({
    config: Object.freeze({ ...routed, workspaceRoot: selectedRoot }),
    sessionId: input.sessionId, surface: 'desktop', desktopSessionRegistry: input.desktopSessionRegistry,
    workspaceBinding: input.workspaceBinding, workspaceBindingResolver: input.workspaceBindingResolver,
    attachmentUploadRead: input.attachmentUploadRead,
    storeRoot: paths.sessions, reviewerRoot: paths.reviewerLedger,
    providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
    secretBroker: options.secretBroker,
    mcpTransportFactory: options.mcpTransportFactory, memoryAdapter: options.memoryAdapter,
    desktopAgentToolCallback: options.desktopAgentToolCallback,
    hookRoot: options.hookRoot ?? paths.hooks, hookRoots: options.hookRoots ?? [],
    skillRoots: selectedSkillRoots, emitContextStatus: true, output: input.output,
    desktopBrowserCallback: options.desktopBrowserCallbackRegistry?.current?.() ?? options.desktopBrowserCallback ?? null,
    forkIngest: input.forkIngest ?? null, modelRoute: input.modelRoute ?? null,
  });
}

async function initializeIntegrationHost(host, signal) {
  try { signal?.throwIfAborted(); await host.initialize(); signal?.throwIfAborted(); return host; }
  catch (error) {
    try { await host.shutdown(); }
    catch (cleanup) {
      const cause = new AggregateError([error, cleanup], 'desktop host initialization and cleanup failed.');
      throw new ContractError('desktop_setup_cleanup_failed', 'desktop host cleanup failed. Restart the native process before retrying.', { cause });
    }
    throw error;
  }
}

async function readIntegrationManifest(path) {
  let bytes;
  try {
    // Invariant: reject a named pipe before open; nonblocking open also closes the replacement race on POSIX.
    if (!(await stat(path)).isFile()) throw new ContractError('desktop_manifest_invalid', 'desktop integration manifest must be a regular file');
    const file = await open(path, fileConstants.O_RDONLY | (fileConstants.O_NONBLOCK ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ContractError('desktop_manifest_invalid', 'desktop integration manifest must be a regular file');
      if (info.size > INTEGRATION_MANIFEST_LIMIT) throw oversizedIntegrationManifest();
      // Invariant: a manifest that grows after stat cannot cause unbounded allocation.
      const buffer = Buffer.alloc(INTEGRATION_MANIFEST_LIMIT + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > INTEGRATION_MANIFEST_LIMIT) throw oversizedIntegrationManifest();
      bytes = buffer.subarray(0, size);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('desktop_manifest_unavailable', 'desktop integration requires the NNA manifest', { cause: error });
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw new ContractError('desktop_manifest_invalid', 'desktop integration manifest is invalid', { cause: error }); }
}

function oversizedIntegrationManifest() {
  return new ContractError('manifest_too_large', 'desktop integration manifest exceeds the size limit');
}

function waitForShutdown(signal, server) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', finish);
      server.off('close', finish);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolve();
    };
    signal?.addEventListener('abort', finish, { once: true });
    server.once('close', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}
