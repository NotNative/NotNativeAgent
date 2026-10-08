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
import { createNndGatewaySettingsTransaction } from './nnd-gateway-timeout-transaction.js';
import { createNndWebFetchSettingsTransaction } from './nnd-web-fetch-transaction.js';
import { createNndWebSearchSettingsTransaction } from './nnd-web-search-transaction.js';
import { createNndCompatibilitySettingsTransaction } from './nnd-compatibility-transaction.js';
import { createNndCompatibilityLifecycleService } from './nnd-compatibility-lifecycle-routes.js';
import { createNndMcpCredentialsService } from './nnd-mcp-credentials-transaction.js';
import { createNndSecretsSettingsService } from './nnd-secrets-routes.js';
import { createNndHooksSettingsService } from './nnd-hooks-routes.js';
import { createNndUpdateActionsService } from './nnd-update-actions-routes.js';
import { createNndPackageActionsService } from './nnd-package-routes.js';
import { createNndEnvironmentSnapshot } from './nnd-environment-snapshot.js';
import { createNndInstallationSnapshot } from './nnd-installation-snapshot.js';
import { createNndBrowserActionsService } from './nnd-browser-routes.js';
import { createNndSkillsService } from './nnd-skills-routes.js';
import { createNndLegacyProviderCredentialsService } from './nnd-legacy-provider-credentials-routes.js';
import { createNndProviderObservation } from './nnd-provider-observation.js';
import { createNndGatewayStatusService, createNndGatewayTestService,
  createNndSearxngStatusService } from './nnd-action-triage-routes.js';
import { createNndInvocationService } from './nnd-invocation-routes.js';
import { userDataPaths } from './product.js';
import { createNndUpdateStateStore } from './nnd-update-state-route.js';
import { createNativeNndTrustServices } from './nnd-trust-routes.js';
import { createNndWorkspaceGrantService } from './nnd-workspace-grants.js';
import { createNndWorkspaceAdmissionService } from './nnd-workspace-admission.js';
import { assertNndTrialOwnership, assertNndTrialRequestAdmission } from './nnd-trial-admission.js';
import { createNndNativePrincipalSelection } from './nnd-native-principal-selection.js';

const PERMISSIONS = Object.freeze(['integration.health', 'nnd.read', 'nnd.setup.read', 'nnd.setup.activate',
  'nnd.session.create', 'nnd.session.submit', 'nnd.session.update', 'nnd.session.abort', 'nnd.session.delete',
  'nnd.goal.manage', 'nnd.steer', 'nnd.walkthrough.generate', 'nnd.notification.generate',
  'nnd.configuration.read', 'nnd.configuration.manage', 'nnd.configuration.repair',
  'nnd.service.manage', 'nnd.update.manage', 'nnd.package.manage',
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

/** One factory per census-classified native settings family, bound to the pair identity.
 * The exported key set is the routing surface: any change to the returned keys
 * changes which routes the native listener can serve (the options spread flows
 * them into the HTTP context verbatim), so the key list is locked by test. */
export function createNativeNndSettingsServices(paths, identity, environment) {
  return {
    nndConfigurationService: createNndConfigurationService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndGatewayTimeoutService: createNndGatewaySettingsTransaction({ path: paths.gatewayConfig,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndWebFetchSettingsService: createNndWebFetchSettingsTransaction({ path: paths.webFetchConfig,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndWebSearchSettingsService: createNndWebSearchSettingsTransaction({ path: paths.webSearchConfig,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndCompatibilitySettingsService: createNndCompatibilitySettingsTransaction({ path: paths.opencodeConfig,
      installationId: identity.installation_id, dataId: identity.data_id, environment }),
    nndCompatibilityLifecycleService: createNndCompatibilityLifecycleService({ paths,
      environment, installationId: identity.installation_id, dataId: identity.data_id }),
    nndMcpCredentialsService: createNndMcpCredentialsService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id, environment }),
    nndSecretsSettingsService: createNndSecretsSettingsService({ broker: new SecretBroker({
      realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault, keyPath: paths.secretKey,
      auditPath: paths.secretAudit }), vaultPath: paths.secretVault,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndHooksSettingsService: createNndHooksSettingsService({ hooksPath: paths.hooks,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndUpdateActionsService: createNndUpdateActionsService({ statePath: paths.updateState,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndPackageActionsService: createNndPackageActionsService({ rootPath: paths.root,
      configPath: paths.config, installationId: identity.installation_id, dataId: identity.data_id }),
    nndWorkspaceGrantService: createNndWorkspaceGrantService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndWorkspaceAdmissionService: createNndWorkspaceAdmissionService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndEnvironmentSnapshotService: createNndEnvironmentSnapshot({ environment,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndInstallationSnapshotService: createNndInstallationSnapshot({ installRoot: identity.install_root,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndBrowserActionsService: createNndBrowserActionsService({
      root: userDataPaths().managedPlaywright,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndSkillsService: createNndSkillsService({ paths, installationId: identity.installation_id,
      dataId: identity.data_id }),
    nndLegacyProviderCredentialsService: createNndLegacyProviderCredentialsService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndProviderObservationService: createNndProviderObservation({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndGatewayStatusService: createNndGatewayStatusService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndGatewayTestService: createNndGatewayTestService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndSearxngStatusService: createNndSearxngStatusService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndInvocationService: createNndInvocationService({
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndUpdateStateStore: createNndUpdateStateStore({ path: paths.updateState,
      installationId: identity.installation_id, dataId: identity.data_id }),
    nndTrustService: createNativeNndTrustServices({ path: paths.trustedWorkspaces,
      installationId: identity.installation_id, dataId: identity.data_id }),
  };
}

export async function startNndNativeService(paths, identity, options = {}) {
  if (options.unpublishedTrial) assertNndTrialOwnership(options.trialAdmissionGate, identity);
  const trialSelection = options.unpublishedTrial
    ? createNndNativePrincipalSelection(identity, options.trialAdmissionGate) : null;
  const token = randomBytes(32).toString('base64url');
  const broker = new SecretBroker({ realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault,
    keyPath: paths.secretKey, auditPath: paths.secretAudit });
  const environment = options.environment ?? process.env;
  // One spread, never a hand-listed options object: dropping a settings
  // service here silently disables its routes (a prior wiring dropped the
  // lifecycle, MCP-credential, secrets, and hooks services), so the whole
  // classified surface set flows to the listener together.
  const settings = createNativeNndSettingsServices(paths, identity, environment);
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment, secretBroker: broker,
    readEffectiveConfiguration: () => readNndSetupConfiguration(paths) });
  const lifecycle = await createIntegrationLifecycle(paths, options, 'nnd', broker, {});
  let service;
  try {
    service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      instanceId: identity.installation_id, broker, providerStore, nndRuntime: lifecycle.runtime,
      ...settings,
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
