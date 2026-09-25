// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto';
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

export async function runIntegrationCommand(args, paths, options = {}) {
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('integration_command_invalid', 'integration command supports serve');
  }
  const environment = options.environment ?? process.env;
  const activation = await validateNnoIntegrationActivation(environment.NNA_NNO_INSTALL_ROOT);
  return runActivatedIntegrationCommand(paths, options, activation, 'nno');
}

export async function runNndIntegrationCommand(args, paths, options = {}) {
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('nnd_command_invalid', 'nnd command supports serve');
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
  const nndEngineHost = await createIntegrationNndEngineHost(paths, options);
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
  const config = resolveManifest(manifest, {
    missionPrincipal: 'authenticated-nnd-operator', principal: 'authenticated-nnd-operator',
    hostOrigin: 'nnd-integration', hostIdentity: 'nnd-integration',
  });
  const host = new NndEngineHost({
    catalogPath: config.persistence === 'durable' ? join(paths.sessions, 'nnd-contexts.json') : null,
    createEngine: async (input) => new SessionEngine({
      config, sessionId: input.sessionId, nndSessionRegistry: input.nndSessionRegistry,
      storeRoot: paths.sessions, reviewerRoot: paths.reviewerLedger,
      providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
      mcpTransportFactory: options.mcpTransportFactory, memoryAdapter: options.memoryAdapter,
      hookRoot: options.hookRoot ?? paths.hooks, hookRoots: options.hookRoots ?? [],
      skillRoots: options.skillRoots ?? [],
      emitContextStatus: true,
      output: input.output,
    }),
  });
  host.workspaceRoot = config.workspaceRoot;
  // Security: expose only the configured route identity to the NND browser, never provider credentials or endpoints.
  host.nndModel = Object.freeze({ providerID: config.routes.primary.providerId, modelID: config.routes.primary.model });
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
