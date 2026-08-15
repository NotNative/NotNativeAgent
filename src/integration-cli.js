// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { startIntegrationServer } from './integration-server.js';
import { validateNnoIntegrationActivation } from './nno-integration-activation.js';
import { ProviderProfileStore } from './provider/profile-store.js';
import { SecretBroker } from './secret-broker.js';

export async function runIntegrationCommand(args, paths, options = {}) {
  if ((args[0] ?? '') !== 'serve' || args.length !== 1) {
    throw new ContractError('integration_command_invalid', 'integration command supports serve');
  }
  const environment = options.environment ?? process.env;
  const activation = await validateNnoIntegrationActivation(environment.NNA_NNO_INSTALL_ROOT);
  const token = randomBytes(32).toString('base64url');
  const instanceId = `nna_${randomUUID()}`;
  const broker = new SecretBroker({
    realm: `nno:${activation.deploymentId}`,
    vaultPath: paths.secretVault, keyPath: paths.secretKey, auditPath: paths.secretAudit,
  });
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment });
  const service = await startIntegrationServer({
    activation, token, instanceId, broker, providerStore, host: '127.0.0.1', port: 0,
  });
  const endpoint = `http://127.0.0.1:${service.address.port}`;
  const output = options.output ?? process.stdout;
  let failure = null;
  try {
    // This single protocol frame is consumed directly by the authenticated NNO parent; the token is required for IPC.
    output.write(`${JSON.stringify({ type: 'ready', protocol: '1.0', endpoint, instance_id: instanceId, token })}\n`);
    await waitForShutdown(options.signal, service.server);
  } catch (error) { failure = error; }
  try { await service.close(); } catch (error) {
    if (!failure) failure = error;
    else if (Object.isExtensible(failure)) failure.secondaryFailures = [...(failure.secondaryFailures ?? []), error];
  }
  if (failure) throw failure;
  return { stopped: true };
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
