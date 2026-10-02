// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createIntegrationLifecycle } from './integration-cli.js';
import { startIntegrationServer } from './integration-server.js';
import { createNndLocalIntegrationActivation } from './nno-integration-activation.js';
import { SecretBroker } from './secret-broker.js';
import { LOCAL_SECRET_REALM } from './secret-contracts.js';
import { ProviderProfileStore } from './provider/profile-store.js';

const PERMISSIONS = Object.freeze(['integration.health', 'nnd.read', 'nnd.setup.read', 'nnd.setup.activate',
  'nnd.session.create', 'nnd.session.submit', 'nnd.session.update', 'nnd.session.abort', 'nnd.session.delete',
  'nnd.goal.manage', 'nnd.steer', 'nnd.walkthrough.generate', 'nnd.notification.generate',
  // Security: management remains scope-filtered and never grants secret.use or raw values.
  'secret.read', 'secret.manage', 'secret.audit',
  'provider.read', 'provider.profile.write', 'provider.discover', 'provider.test', 'provider.route.manage', 'provider.route.activate']);

export function nativeNndPrincipal(workspaceRoot) {
  const workspaceIds = workspaceRoot ? [`ws_${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24)}`] : [];
  return Object.freeze({ subjectId: 'nnd-local-operator', platformRole: 'operator', permissions: PERMISSIONS,
    workspaceIds: Object.freeze(workspaceIds), groupIds: Object.freeze([]), traceId: randomUUID(),
    requestId: randomUUID(), issuedAt: new Date() });
}

export async function startNndNativeService(paths, identity, options = {}) {
  const token = randomBytes(32).toString('base64url');
  const broker = new SecretBroker({ realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault,
    keyPath: paths.secretKey, auditPath: paths.secretAudit });
  const environment = options.environment ?? process.env;
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment, secretBroker: broker });
  const lifecycle = await createIntegrationLifecycle(paths, options, 'nnd', broker, {});
  let service;
  try {
    service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      instanceId: identity.installation_id, broker, providerStore, nndRuntime: lifecycle.runtime,
      resolvePrincipal: () => nativeNndPrincipal(lifecycle.getHost()?.workspaceRoot), host: '127.0.0.1', port: 0 });
  } catch (error) { await lifecycle.close(); throw error; }
  lifecycle.runtime.start();
  let closing;
  return { runtime: lifecycle.runtime, endpoint: `http://127.0.0.1:${service.address.port}`, token,
    close() {
      closing ??= (async () => {
        service.stopAdmission();
        const runtimeClose = lifecycle.close();
        const listenerClose = service.close();
        service.server.closeAllConnections();
        const results = await Promise.allSettled([runtimeClose, listenerClose, service.drain()]);
        const failures = results.filter((item) => item.status === 'rejected').map((item) => item.reason);
        if (failures.length) throw new AggregateError(failures, 'Native NND shutdown failed');
      })();
      return closing;
    } };
}
