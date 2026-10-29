// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

test('same native listener resolves operator principal only after private promotion', async () => {
  let promoted = false, serverOptions;
  const dependencies = { createHash, randomBytes, randomUUID,
    SecretBroker: class {}, ProviderProfileStore: class {}, LOCAL_SECRET_REALM: 'local',
    readDesktopSetupConfiguration: () => ({}), createDesktopConfigurationService: () => ({}),
    createDesktopGatewaySettingsTransaction: () => ({}),
    createDesktopWebFetchSettingsTransaction: () => ({}),
    createDesktopWebSearchSettingsTransaction: () => ({}),
    createDesktopCompatibilitySettingsTransaction: () => ({})
    , createDesktopCompatibilityLifecycleService: () => ({})
    , createDesktopMcpCredentialsService: () => ({})
    , createDesktopSecretsSettingsService: () => ({})
    , createDesktopHooksSettingsService: () => ({})
    , createDesktopUpdateActionsService: () => ({})
    , createDesktopPackageActionsService: () => ({}) ,
    createDesktopWorkspaceGrantService: () => ({}), createDesktopWorkspaceAdmissionService: () => ({}),
    createDesktopEnvironmentSnapshot: () => ({}),
    createDesktopInstallationSnapshot: () => ({}), createDesktopBrowserActionsService: () => ({}),
    createDesktopSkillsService: () => ({}), createDesktopLegacyProviderCredentialsService: () => ({}),
    createDesktopProviderObservation: () => ({}), createDesktopGatewayStatusService: () => ({}), createDesktopGatewayTestService: () => ({}),
    createDesktopSearxngStatusService: () => ({}), createDesktopInvocationService: () => ({}),
    userDataPaths: () => ({ managedPlaywright: 'C:\\nna\\managed\\playwright' }),
    createDesktopUpdateStateStore: () => ({}), createNativeDesktopTrustServices: () => ({}),
    createDesktopLocalIntegrationActivation: () => ({}),
    createIntegrationLifecycle: async () => ({ runtime: { start() {}, snapshot: () => ({}) },
      getHost: () => ({ workspaceRoot: 'C:\\workspace' }), close: async () => {} }),
    startIntegrationServer: async options => { serverOptions = options;
      return { address: { port: 12345 }, server: { listening: true, address: () => ({ port: 12345 }) } }; },
    createDesktopNativePrincipalSelection: () => ({ promoted: () => promoted }),
    assertDesktopTrialOwnership: () => {}, assertDesktopTrialRequestAdmission: () => {} };
  const source = await readFile(new URL('../src/desktop-service-native.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
  const start = Function(...Object.keys(dependencies), `${executable}\nreturn startDesktopNativeService;`)
    (...Object.values(dependencies));
  await start({ secretVault: '', secretKey: '', secretAudit: '', config: '' },
    { installation_id: 'nna_test' }, { unpublishedTrial: true, trialAdmissionGate: {} });
  const trial = serverOptions.resolvePrincipal();
  assert.equal(trial.permissions.includes('desktop.session.create'), false);
  promoted = true;
  const operator = serverOptions.resolvePrincipal();
  assert.equal(operator.permissions.includes('desktop.session.create'), true);
  assert.equal(operator.subjectId, trial.subjectId);
});
