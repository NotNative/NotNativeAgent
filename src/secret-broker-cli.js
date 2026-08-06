// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { SecretBroker } from './secret-broker.js';
import { startSecretBrokerServer } from './secret-broker-server.js';

export async function runSecretBrokerCommand(args, paths, options = {}) {
  const action = args[0] ?? 'status';
  if (action !== 'serve') throw new ContractError('secret_broker_command_invalid', 'secrets command supports serve');
  const environment = options.environment ?? process.env;
  const realm = requireRealm(environment.NNA_SECRET_BROKER_REALM);
  const token = environment.NNA_SECRET_BROKER_TOKEN;
  const host = environment.NNA_SECRET_BROKER_HOST ?? '127.0.0.1';
  const port = environment.NNA_SECRET_BROKER_PORT ? Number(environment.NNA_SECRET_BROKER_PORT) : 7321;
  const broker = new SecretBroker({
    realm, vaultPath: paths.secretVault, keyPath: paths.secretKey, auditPath: paths.secretAudit,
  });
  const service = await startSecretBrokerServer({ broker, token, host, port });
  const address = service.address;
  options.output?.write(`${JSON.stringify({ ready: true, host: address.address, port: address.port, realm })}\n`);
  await waitForShutdown(options.signal, service.server);
  await service.close();
  return { stopped: true, realm };
}

function requireRealm(value) {
  if (typeof value !== 'string' || !/^nno:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) {
    throw new ContractError('secret_broker_realm_invalid', 'NNA_SECRET_BROKER_REALM must use nno:<deployment-id>');
  }
  return value;
}

function waitForShutdown(signal, server) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => resolve();
    signal?.addEventListener('abort', finish, { once: true });
    server.once('close', finish);
    process.once('SIGINT', finish); process.once('SIGTERM', finish);
  });
}
