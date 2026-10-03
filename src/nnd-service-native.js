// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createIntegrationLifecycle } from './integration-cli.js';
import { startIntegrationServer } from './integration-server.js';
import { createNndLocalIntegrationActivation } from './nno-integration-activation.js';
import { SecretBroker } from './secret-broker.js';
import { LOCAL_SECRET_REALM } from './secret-contracts.js';
import { ProviderProfileStore } from './provider/profile-store.js';
import { readNndSetupConfiguration } from './nnd-setup-config.js';
import { createNndConfigurationService } from './nnd-configuration-service.js';
import { createNndGatewayTimeoutTransaction } from './nnd-gateway-timeout-transaction.js';
import { createNndWorkspaceGrantService } from './nnd-workspace-grants.js';
import { assertNndTrialOwnership, assertNndTrialRequestAdmission } from './nnd-trial-admission.js';
import { createNndNativePrincipalSelection } from './nnd-native-principal-selection.js';

const PERMISSIONS = Object.freeze(['integration.health', 'nnd.read', 'nnd.setup.read', 'nnd.setup.activate',
  'nnd.session.create', 'nnd.session.submit', 'nnd.session.update', 'nnd.session.abort', 'nnd.session.delete',
  'nnd.goal.manage', 'nnd.steer', 'nnd.walkthrough.generate', 'nnd.notification.generate',
  'nnd.configuration.read', 'nnd.configuration.manage', 'nnd.configuration.repair',
  'nnd.workspace.read', 'nnd.workspace.manage',
  // Security: management remains scope-filtered and never grants secret.use or raw values.
  'secret.read', 'secret.manage', 'secret.audit',
  'provider.read', 'provider.profile.write', 'provider.discover', 'provider.test', 'provider.route.manage', 'provider.route.activate']);

export function nativeNndPrincipal(workspaceRoot) {
  const workspaceIds = workspaceRoot ? [`ws_${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24)}`] : [];
  return Object.freeze({ subjectId: 'nnd-local-operator', platformRole: 'operator', permissions: PERMISSIONS,
    workspaceIds: Object.freeze(workspaceIds), groupIds: Object.freeze([]), traceId: randomUUID(),
    requestId: randomUUID(), issuedAt: new Date() });
}

const TRIAL_PERMISSIONS = Object.freeze(['integration.health', 'nnd.read', 'nnd.setup.read',
  'nnd.configuration.read', 'nnd.workspace.read', 'provider.read']);
export function nativeNndTrialPrincipal(workspaceRoot) {
  return Object.freeze({ ...nativeNndPrincipal(workspaceRoot), permissions: TRIAL_PERMISSIONS });
}

export async function startNndNativeService(paths, identity, options = {}) {
  if (options.unpublishedTrial) assertNndTrialOwnership(options.trialAdmissionGate, identity);
  const trialSelection = options.unpublishedTrial
    ? createNndNativePrincipalSelection(identity, options.trialAdmissionGate) : null;
  const token = randomBytes(32).toString('base64url');
  const broker = new SecretBroker({ realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault,
    keyPath: paths.secretKey, auditPath: paths.secretAudit });
  const environment = options.environment ?? process.env;
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment, secretBroker: broker,
    readEffectiveConfiguration: () => readNndSetupConfiguration(paths) });
  const nndConfigurationService = createNndConfigurationService({
    paths, installationId: identity.installation_id, dataId: identity.data_id,
  });
  const nndGatewayTimeoutService = createNndGatewayTimeoutTransaction({ path: paths.gatewayConfig,
    installationId: identity.installation_id, dataId: identity.data_id });
  const nndWorkspaceGrantService = createNndWorkspaceGrantService({
    paths, installationId: identity.installation_id, dataId: identity.data_id,
  });
  const lifecycle = await createIntegrationLifecycle(paths, options, 'nnd', broker, {});
  let service;
  try {
    service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      instanceId: identity.installation_id, broker, providerStore, nndRuntime: lifecycle.runtime,
      nndConfigurationService, nndGatewayTimeoutService, nndWorkspaceGrantService,
      ...(options.unpublishedTrial ? { assertAdmission: request =>
        assertNndTrialRequestAdmission(options.trialAdmissionGate, identity, request) } : {}),
      resolvePrincipal: () => options.unpublishedTrial && !trialSelection.promoted()
        ? nativeNndTrialPrincipal(lifecycle.getHost()?.workspaceRoot)
        : nativeNndPrincipal(lifecycle.getHost()?.workspaceRoot), host: '127.0.0.1', port: 0 });
  } catch (error) { await lifecycle.close(); throw error; }
  lifecycle.runtime.start();
  let closing;
  const native = { runtime: lifecycle.runtime, endpoint: `http://127.0.0.1:${service.address.port}`, token,
    isListening: () => service.server.listening && service.server.address() !== null,
    ...(trialSelection ? { selectTrialPrincipal: (proof, state, serviceLease, registryLease, binding) =>
      trialSelection.select(native, proof, state, serviceLease, registryLease, binding),
    selectedPrincipalEvidence: state => trialSelection.evidence(native, state),
    confirmHeldTicket: (proof, state, serviceLease, registryLease, binding) =>
      trialSelection.confirmTicket(native, proof, state, serviceLease, registryLease, binding),
    confirmedHeldTicketEvidence: state => trialSelection.confirmedTicket(native, state),
    promoteTrialPrincipal: (state, serviceLease, registryLease, binding) =>
      trialSelection.promote(native, state, serviceLease, registryLease, binding),
    promotedPrincipalEvidence: state => trialSelection.promoted()
      ? trialSelection.confirmedTicket(native, state) : null } : {}),
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
  return native;
}
