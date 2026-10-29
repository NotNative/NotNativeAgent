// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createIntegrationLifecycle } from './integration-cli.js';
import { startIntegrationServer } from './integration-server.js';
import { createDesktopLocalIntegrationActivation } from './nno-integration-activation.js';
import { SecretBroker } from './secret-broker.js';
import { LOCAL_SECRET_REALM } from './secret-contracts.js';
import { ProviderProfileStore } from './provider/profile-store.js';
import { readDesktopSetupConfiguration } from './desktop-setup-config.js';
import { createDesktopConfigurationService } from './desktop-configuration-service.js';
import { readDesktopConfigurationSources } from './desktop-configuration-sources.js';
import { createDesktopGatewaySettingsTransaction } from './desktop-gateway-timeout-transaction.js';
import { createDesktopWebFetchSettingsTransaction } from './desktop-web-fetch-transaction.js';
import { createDesktopWebSearchSettingsTransaction } from './desktop-web-search-transaction.js';
import { createDesktopCompatibilitySettingsTransaction } from './desktop-compatibility-transaction.js';
import { createDesktopCompatibilityLifecycleService } from './desktop-compatibility-lifecycle-routes.js';
import { createDesktopMcpCredentialsService } from './desktop-mcp-credentials-transaction.js';
import { createDesktopSecretsSettingsService } from './desktop-secrets-routes.js';
import { createDesktopHooksSettingsService } from './desktop-hooks-routes.js';
import { createDesktopUpdateActionsService } from './desktop-update-actions-routes.js';
import { createDesktopPackageActionsService } from './desktop-package-routes.js';
import { createDesktopEnvironmentSnapshot } from './desktop-environment-snapshot.js';
import { createDesktopInstallationSnapshot } from './desktop-installation-snapshot.js';
import { createDesktopBrowserActionsService } from './desktop-browser-routes.js';
import { createDesktopSkillsService } from './desktop-skills-routes.js';
import { createDesktopLegacyProviderCredentialsService } from './desktop-legacy-provider-credentials-routes.js';
import { createDesktopProviderObservation } from './desktop-provider-observation.js';
import { createDesktopGatewayStatusService, createDesktopGatewayTestService,
  createDesktopSearxngStatusService } from './desktop-action-triage-routes.js';
import { createDesktopInvocationService } from './desktop-invocation-routes.js';
import { userDataPaths } from './product.js';
import { createDesktopUpdateStateStore } from './desktop-update-state-route.js';
import { createNativeDesktopTrustServices } from './desktop-trust-routes.js';
import { createDesktopWorkspaceGrantService } from './desktop-workspace-grants.js';
import { createDesktopWorkspaceAdmissionService } from './desktop-workspace-admission.js';
import { assertDesktopTrialOwnership, assertDesktopTrialRequestAdmission } from './desktop-trial-admission.js';
import { createDesktopNativePrincipalSelection } from './desktop-native-principal-selection.js';

const PERMISSIONS = Object.freeze(['integration.health', 'desktop.read', 'desktop.setup.read', 'desktop.setup.activate',
  'desktop.session.create', 'desktop.session.submit', 'desktop.session.update', 'desktop.session.abort', 'desktop.session.delete',
  'desktop.session.assist',
  'desktop.goal.manage', 'desktop.steer', 'desktop.walkthrough.generate', 'desktop.notification.generate',
  'desktop.configuration.read', 'desktop.configuration.manage', 'desktop.configuration.repair',
  'desktop.service.manage', 'desktop.update.manage', 'desktop.package.manage',
  'desktop.workspace.read', 'desktop.workspace.manage',
  // Runtime registration of the desktop browser callback (attach mode).
  'desktop.browser.manage',
  // Security: management remains scope-filtered and never grants secret.use or raw values.
  'secret.read', 'secret.manage', 'secret.audit',
  'provider.read', 'provider.profile.write', 'provider.discover', 'provider.test', 'provider.route.manage', 'provider.route.activate']);

export function nativeDesktopPrincipal(workspaceRoot) {
  const workspaceIds = workspaceRoot ? [`ws_${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 24)}`] : [];
  return Object.freeze({ subjectId: 'desktop-local-operator', platformRole: 'operator', permissions: PERMISSIONS,
    workspaceIds: Object.freeze(workspaceIds), groupIds: Object.freeze([]), traceId: randomUUID(),
    requestId: randomUUID(), issuedAt: new Date() });
}

const TRIAL_PERMISSIONS = Object.freeze(['integration.health', 'desktop.read', 'desktop.setup.read',
  'desktop.configuration.read', 'desktop.workspace.read', 'provider.read']);
export function nativeDesktopTrialPrincipal(workspaceRoot) {
  return Object.freeze({ ...nativeDesktopPrincipal(workspaceRoot), permissions: TRIAL_PERMISSIONS });
}

/** One factory per census-classified native settings family, bound to the pair identity.
 * The exported key set is the routing surface: any change to the returned keys
 * changes which routes the native listener can serve (the options spread flows
 * them into the HTTP context verbatim), so the key list is locked by test. */
export function createNativeDesktopSettingsServices(paths, identity, environment) {
  return {
    // Derived-reference scan for the secret delete guard (census
    // secrets:delete_guard): resolved sources give providerProfiles/mcpServers.
    secretReferences: async () => (await readDesktopConfigurationSources(paths)).config,
    desktopConfigurationService: createDesktopConfigurationService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopGatewayTimeoutService: createDesktopGatewaySettingsTransaction({ path: paths.gatewayConfig,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopWebFetchSettingsService: createDesktopWebFetchSettingsTransaction({ path: paths.webFetchConfig,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopWebSearchSettingsService: createDesktopWebSearchSettingsTransaction({ path: paths.webSearchConfig,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopCompatibilitySettingsService: createDesktopCompatibilitySettingsTransaction({ path: paths.opencodeConfig,
      installationId: identity.installation_id, dataId: identity.data_id, environment }),
    desktopCompatibilityLifecycleService: createDesktopCompatibilityLifecycleService({ paths,
      environment, installationId: identity.installation_id, dataId: identity.data_id }),
    desktopMcpCredentialsService: createDesktopMcpCredentialsService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id, environment }),
    desktopSecretsSettingsService: createDesktopSecretsSettingsService({ broker: new SecretBroker({
      realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault, keyPath: paths.secretKey,
      auditPath: paths.secretAudit }), vaultPath: paths.secretVault,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopHooksSettingsService: createDesktopHooksSettingsService({ hooksPath: paths.hooks,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopUpdateActionsService: createDesktopUpdateActionsService({ statePath: paths.updateState,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopPackageActionsService: createDesktopPackageActionsService({ rootPath: paths.root,
      configPath: paths.config, installationId: identity.installation_id, dataId: identity.data_id }),
    desktopWorkspaceGrantService: createDesktopWorkspaceGrantService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopWorkspaceAdmissionService: createDesktopWorkspaceAdmissionService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopEnvironmentSnapshotService: createDesktopEnvironmentSnapshot({ environment,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopInstallationSnapshotService: createDesktopInstallationSnapshot({ installRoot: identity.install_root,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopBrowserActionsService: createDesktopBrowserActionsService({
      root: userDataPaths().managedPlaywright,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopSkillsService: createDesktopSkillsService({ paths, installationId: identity.installation_id,
      dataId: identity.data_id }),
    desktopLegacyProviderCredentialsService: createDesktopLegacyProviderCredentialsService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopProviderObservationService: createDesktopProviderObservation({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopGatewayStatusService: createDesktopGatewayStatusService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopGatewayTestService: createDesktopGatewayTestService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopSearxngStatusService: createDesktopSearxngStatusService({ paths,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopInvocationService: createDesktopInvocationService({
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopUpdateStateStore: createDesktopUpdateStateStore({ path: paths.updateState,
      installationId: identity.installation_id, dataId: identity.data_id }),
    desktopTrustService: createNativeDesktopTrustServices({ path: paths.trustedWorkspaces,
      installationId: identity.installation_id, dataId: identity.data_id }),
  };
}

export async function startDesktopNativeService(paths, identity, options = {}) {
  if (options.unpublishedTrial) assertDesktopTrialOwnership(options.trialAdmissionGate, identity);
  const trialSelection = options.unpublishedTrial
    ? createDesktopNativePrincipalSelection(identity, options.trialAdmissionGate) : null;
  const token = randomBytes(32).toString('base64url');
  const broker = new SecretBroker({ realm: LOCAL_SECRET_REALM, vaultPath: paths.secretVault,
    keyPath: paths.secretKey, auditPath: paths.secretAudit });
  const environment = options.environment ?? process.env;
  // One spread, never a hand-listed options object: dropping a settings
  // service here silently disables its routes (a prior wiring dropped the
  // lifecycle, MCP-credential, secrets, and hooks services), so the whole
  // classified surface set flows to the listener together.
  const settings = createNativeDesktopSettingsServices(paths, identity, environment);
  const providerStore = new ProviderProfileStore({ configRoot: paths.config, environment, secretBroker: broker,
    readEffectiveConfiguration: () => readDesktopSetupConfiguration(paths) });
  const lifecycle = await createIntegrationLifecycle(paths,
    { ...options, workspaceAdmissionService: settings.desktopWorkspaceAdmissionService }, 'desktop', broker, {});
  let service;
  try {
    service = await startIntegrationServer({ activation: createDesktopLocalIntegrationActivation(), token,
      instanceId: identity.installation_id, broker, providerStore, desktopRuntime: lifecycle.runtime,
      ...(options.capabilityAuthority ? { capabilityAuthority: options.capabilityAuthority } : {}),
      desktopBrowserCallbackRegistry: lifecycle.desktopBrowserCallbackRegistry,
      ...settings,
      ...(options.unpublishedTrial ? { assertAdmission: request =>
        assertDesktopTrialRequestAdmission(options.trialAdmissionGate, identity, request) } : {}),
      resolvePrincipal: () => options.unpublishedTrial && !trialSelection.promoted()
        ? nativeDesktopTrialPrincipal(lifecycle.getHost()?.workspaceRoot)
        : nativeDesktopPrincipal(lifecycle.getHost()?.workspaceRoot), host: '127.0.0.1', port: 0 });
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
        if (failures.length) throw new AggregateError(failures, 'Native desktop shutdown failed');
      })();
      return closing;
    } };
  return native;
}
