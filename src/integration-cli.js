// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';
import { startIntegrationServer } from './integration-server.js';
import { createNndLocalIntegrationActivation, validateNnoIntegrationActivation } from './nno-integration-activation.js';
import { ProviderProfileStore } from './provider/profile-store.js';
import { SecretBroker } from './secret-broker.js';
import { resolveManifest } from './config.js';
import { SessionEngine } from './engine.js';
import { NndEngineHost } from './nnd-engine-host.js';
import { nndMcpInventory } from './nnd-mcp-inventory.js';
import { nndSkillsInventory } from './nnd-skills-inventory.js';
import { nndAgentInventory } from './nnd-agent-inventory.js';
import { SkillRegistry } from './skill-registry.js';
import { runtimeSkillRoots } from './startup-configuration.js';
import { workspaceIsTrusted } from './experience/trust.js';
import { consumeNndBrowserCallbackFromEnvironment } from './nnd-browser-tool.js';
import { runNndPackageCommand } from './nnd-package.js';

export async function runIntegrationCommand(args, paths, options = {}) {
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('integration_command_invalid', 'integration command supports serve');
  }
  const environment = options.environment ?? process.env;
  const activation = await validateNnoIntegrationActivation(environment.NNA_NNO_INSTALL_ROOT);
  return runActivatedIntegrationCommand(paths, options, activation, 'nno');
}

export async function runNndIntegrationCommand(args, paths, options = {}) {
  if (args[0] === 'package') return runNndPackageCommand(args.slice(1), paths);
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('nnd_command_invalid', 'nnd command supports serve and package');
  }
  return runActivatedIntegrationCommand(paths, options, createNndLocalIntegrationActivation(), 'nnd');
}

async function runActivatedIntegrationCommand(paths, options, activation, owner) {
  const environment = options.environment ?? process.env;
  const token = randomBytes(32).toString('base64url');
  const instanceId = `nna_${randomUUID()}`;
  const broker = new SecretBroker({
    realm: `${owner}:${activation.deploymentId}`,
    vaultPath: paths.secretVault, keyPath: paths.secretKey, auditPath: paths.secretAudit,
  });
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment, secretBroker: broker });
  const nndEngineHost = await createIntegrationNndEngineHost(paths, {
    ...options, nndBrowserCallback: owner === 'nnd' ? consumeNndBrowserCallbackFromEnvironment(environment) : null,
  });
  let service;
  try {
    service = await startIntegrationServer({
      activation, token, instanceId, broker, providerStore, nndEngineHost, nndWorkspaceRoot: nndEngineHost.workspaceRoot, host: '127.0.0.1', port: 0,
    });
  } catch (error) {
    try { await nndEngineHost.shutdown(); }
    catch (shutdownError) {
      if (Object.isExtensible(error)) error.secondaryFailures = [...(error.secondaryFailures ?? []), shutdownError];
    }
    throw error;
  }
  const endpoint = `http://127.0.0.1:${service.address.port}`;
  const output = options.output ?? process.stdout;
  let failure = null;
  try {
    // Security: stdout is one readiness frame for the owning local process; the token is not logged.
    output.write(`${JSON.stringify({ type: 'ready', protocol: '1.0', endpoint, instance_id: instanceId, token })}\n`);
    await waitForShutdown(options.signal, service.server);
  } catch (error) { failure = error; }
  try { await service.close(); } catch (error) {
    if (!failure) failure = error;
    else if (Object.isExtensible(failure)) failure.secondaryFailures = [...(failure.secondaryFailures ?? []), error];
  }
  try { await nndEngineHost.shutdown(); } catch (error) {
    if (!failure) failure = error;
    else if (Object.isExtensible(failure)) failure.secondaryFailures = [...(failure.secondaryFailures ?? []), error];
  }
  if (failure) throw failure;
  return { stopped: true };
}

export async function createIntegrationNndEngineHost(paths, options = {}) {
  const manifest = await readIntegrationManifest(join(paths.config, 'manifest.json'));
  const configOptions = {
    missionPrincipal: 'authenticated-nnd-operator', principal: 'authenticated-nnd-operator',
    hostOrigin: 'nnd-integration', hostIdentity: 'nnd-integration',
  };
  const config = resolveManifest(manifest, configOptions);
  let activeConfig = config;
  const trusted = typeof paths.trustedWorkspaces === 'string'
    ? await workspaceIsTrusted(paths.trustedWorkspaces, config.workspaceRoot) : false;
  const skillRoots = options.skillRoots ?? runtimeSkillRoots(paths, {
    trusted, skillRoot: join(config.workspaceRoot, '.nna', 'skills'),
  });
  const host = new NndEngineHost({
    catalogPath: config.persistence === 'durable' ? join(paths.sessions, 'nnd-contexts.json') : null,
    createEngine: async (input) => new SessionEngine({
      config: activeConfig, sessionId: input.sessionId, surface: 'nnd', nndSessionRegistry: input.nndSessionRegistry,
      storeRoot: paths.sessions, reviewerRoot: paths.reviewerLedger,
      providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
      mcpTransportFactory: options.mcpTransportFactory, memoryAdapter: options.memoryAdapter,
      hookRoot: options.hookRoot ?? paths.hooks, hookRoots: options.hookRoots ?? [],
      skillRoots,
      emitContextStatus: true,
      output: input.output,
      nndBrowserCallback: options.nndBrowserCallback,
    }),
  });
  host.workspaceRoot = config.workspaceRoot;
  // Security: expose only the configured route identity to the NND browser, never provider credentials or endpoints.
  host.nndModel = Object.freeze({ providerID: config.routes.primary.providerId, modelID: config.routes.primary.model });
  host.nndMcpInventory = nndMcpInventory(config);
  host.nndAgentInventory = nndAgentInventory(config);
  host.providerRoutingPending = (latest) => !isDeepStrictEqual(activeConfig.providerProfiles, latest.providerProfiles)
    || !isDeepStrictEqual(activeConfig.routes, latest.routes);
  host.activateProviderRoute = async () => {
    const latest = resolveManifest(await readIntegrationManifest(join(paths.config, 'manifest.json')), configOptions);
    if (latest.workspaceRoot !== config.workspaceRoot || latest.persistence !== config.persistence) {
      throw new ContractError('nnd_manifest_invalid', 'NND provider activation cannot change workspace or persistence scope');
    }
    activeConfig = Object.freeze({ ...activeConfig, providerProfiles: latest.providerProfiles, routes: latest.routes });
    const route = activeConfig.routes.primary;
    host.nndModel = Object.freeze({ providerID: route.providerId, modelID: route.model });
    host.nndAgentInventory = nndAgentInventory(activeConfig);
    return host.nndModel;
  };
  // A newly created session discovers these same roots at initialization.
  // Read again per request so the UI does not freeze a startup-only catalog.
  host.readNndSkillsInventory = async () => {
    const skills = new SkillRegistry({ roots: skillRoots });
    try { await skills.initialize(); }
    catch { throw new ContractError('nnd_skills_unavailable', 'NNA skill discovery is unavailable'); }
    return nndSkillsInventory(skills.catalog());
  };
  await host.initialize();
  return host;
}

async function readIntegrationManifest(path) {
  let source;
  try { source = await readFile(path, 'utf8'); }
  catch (error) { throw new ContractError('nnd_manifest_unavailable', 'NND integration requires the NNA manifest', { cause: error }); }
  try { return JSON.parse(source); }
  catch (error) { throw new ContractError('nnd_manifest_invalid', 'NND integration manifest is invalid', { cause: error }); }
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
