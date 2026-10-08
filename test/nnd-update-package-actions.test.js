// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNndUpdateActionsService, projectAction as projectUpdateAction } from '../src/nnd-update-actions-routes.js';
import { createNndPackageActionsService, projectAction as projectPackageAction } from '../src/nnd-package-routes.js';
import { createNativeNndSettingsServices } from '../src/nnd-service-native.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

// Manifest transactions fail closed in front of unknown parent ACLs, so the
// fixtures live in the home directory on Windows exactly like the CLI tests.
const scratch = () => mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-update-actions-'));

const identity = { installation_id: 'install_updates', data_id: 'data_updates', install_root: 'C:\\nna' };
const token = 'update-package-http-token-36-chars-test';
const updatePrincipal = { subjectId: 'operator@example.com', permissions: ['nnd.update.manage'] };

test('the exported settings-service key set is the exact routing surface', () => {
  const paths = Object.freeze({
    gatewayConfig: join(tmpdir(), 'gateway.json'), gateway: join(tmpdir(), 'gateway'),
    managedSearxng: join(tmpdir(), 'managed-searxng'),
    webFetchConfig: join(tmpdir(), 'web-fetch.json'),
    webSearchConfig: join(tmpdir(), 'web-search.json'), opencodeConfig: join(tmpdir(), 'opencode.json'),
    opencode: join(tmpdir(), 'opencode'), logs: join(tmpdir(), 'logs'), hooks: join(tmpdir(), 'hooks'),
    config: join(tmpdir(), 'config'), secretVault: join(tmpdir(), 'vault.json'),
    secretKey: join(tmpdir(), 'key.json'), secretAudit: join(tmpdir(), 'audit.ndjson'),
    trustedWorkspaces: join(tmpdir(), 'trusted-workspaces.json'),
    updateState: join(tmpdir(), 'update-state.json'), root: tmpdir(),
    mcpCredentials: join(tmpdir(), 'mcp-credentials.json'),
    providerCredentials: join(tmpdir(), 'provider-credentials.json'),
    skills: join(tmpdir(), 'skills'),
  });
  const services = createNativeNndSettingsServices(paths, identity, {});
  assert.deepEqual(Object.keys(services).sort(), [
    'nndBrowserActionsService', 'nndCompatibilityLifecycleService', 'nndCompatibilitySettingsService',
    'nndConfigurationService', 'nndEnvironmentSnapshotService',
    'nndGatewayStatusService', 'nndGatewayTestService', 'nndGatewayTimeoutService',
    'nndHooksSettingsService', 'nndInstallationSnapshotService', 'nndInvocationService',
    'nndLegacyProviderCredentialsService', 'nndMcpCredentialsService', 'nndPackageActionsService',
    'nndProviderObservationService',
    'nndSearxngStatusService', 'nndSecretsSettingsService', 'nndSkillsService', 'nndTrustService',
    'nndUpdateActionsService', 'nndUpdateStateStore', 'nndWebFetchSettingsService',
    'nndWebSearchSettingsService', 'nndWorkspaceAdmissionService', 'nndWorkspaceGrantService']);
});

test('update check reuse projects the availability receipt grammar and refuses drift', async () => {
  const root = await scratch();
  try {
    const statePath = join(root, 'update-state.json');
    const service = createNndUpdateActionsService({ statePath,
      fetchImpl: async (url) => {
        if (!String(url).includes('/commits/main')) {
          return { ok: true, status: 200, text: async () => '20261006-9', json: async () => null,
            headers: new Map() };
        }
        return { ok: true, status: 200, json: async () => ({ sha: 'a'.repeat(40) }) };
      },
      currentVersion: '20261006-3', installationId: identity.installation_id, dataId: identity.data_id });
    const receipt = projectUpdateAction(await service.check());
    assert.equal(receipt.action, 'check');
    assert.equal(receipt.application, 'update_check_recorded');
    assert.deepEqual(Object.keys(receipt).sort(), ['action', 'application', 'availability', 'data_id',
      'installation_id', 'operation_id', 'schema_version', 'scope']);
    assert.deepEqual(Object.keys(receipt.availability).sort(), ['available', 'cached', 'checked_at',
      'current_version', 'error_code', 'latest_ref', 'latest_sha', 'latest_tag', 'latest_version', 'status']);
    assert.equal(receipt.availability.status, 'ready');
    assert.equal(receipt.availability.latest_version, '20261006-9');
    assert.equal(receipt.availability.current_version, '20261006-3');
    assert.equal(receipt.availability.available, true);
    assert.equal(receipt.availability.cached, false);
    assert.equal(receipt.availability.error_code, null);
    // A refusing network turns the next forced check into the honest
    // unavailability receipt (the CLI's stable error code rides the record).
    const refusing = createNndUpdateActionsService({ statePath,
      fetchImpl: async () => { throw new Error('network-refused-in-test'); },
      currentVersion: '20261006-3', installationId: identity.installation_id, dataId: identity.data_id });
    const unavailable = projectUpdateAction(await refusing.check());
    assert.equal(unavailable.availability.status, 'unavailable');
    assert.equal(unavailable.availability.available, false);
    assert.equal(unavailable.availability.error_code, 'update_check_unavailable');
    const sampleOperationId = '550e8400-e29b-41d4-a716-446655440000';
    const rawValue = { ...unavailable.availability };
    assert.throws(() => projectUpdateAction({ installationId: identity.installation_id,
      dataId: identity.data_id, operationId: sampleOperationId,
      value: { ...rawValue, extra: 1 } }), { code: 'nnd_update_projection_invalid' });
    assert.throws(() => projectUpdateAction({ installationId: identity.installation_id,
      dataId: identity.data_id, operationId: sampleOperationId,
      value: { ...rawValue, status: 'maybe' } }), { code: 'nnd_update_projection_invalid' });
    assert.throws(() => projectUpdateAction({ installationId: identity.installation_id,
      dataId: identity.data_id, operationId: 'not-a-uuid',
      value: rawValue }), { code: 'nnd_update_projection_invalid' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update http serves the refused install pin, refresh check, and permission gate', async () => {
  const root = await scratch();
  try {
    const statePath = join(root, 'update-state.json');
    const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      host: '127.0.0.1', port: 0,
      nndRuntime: { getHost: () => null, snapshot: () => ({ service_state: 'ready',
        execution_state: 'unavailable' }) },
      resolvePrincipal: () => updatePrincipal,
      nndUpdateActionsService: createNndUpdateActionsService({ statePath,
        fetchImpl: async () => { throw new Error('network-refused-in-test'); },
        installationId: identity.installation_id, dataId: identity.data_id }) });
    try {
      const base = `http://127.0.0.1:${server.address.port}/v1/nnd/configuration/update/actions`;
      const call = async (action, method = 'POST', bearer = token) => {
        const response = await fetch(`${base}/${action}`, { method,
          headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) } });
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      const refused = await call('install');
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, 'nnd_update_install_unsupported');
      const probe = await call('check');
      assert.equal(probe.status, 200);
      assert.equal(probe.body.action, 'check');
      assert.equal(probe.body.availability.status, 'unavailable');
      assert.equal(probe.body.availability.error_code, 'update_check_unavailable');
      assert.equal((await call('check', 'GET', token)).status, 405);
      assert.equal((await call('check', 'POST', 'wrong-token')).status, 401);
      assert.equal((await call('check', 'POST', token.replace('t', 'x'))).status, 401);
      const absent = await call('nothing');
      assert.equal(absent.status, 404);
    } finally {
      server.server.closeAllConnections();
      await server.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const validPackageRoot = async (root) => {
  const manifestPath = join(root, 'nna-integration', 'nnd-local');
  await mkdir(manifestPath, { recursive: true });
  await writeFile(join(manifestPath, 'integration.json'), JSON.stringify({ id: 'nnd-local',
    ownership: 'nnd', scope: 'local-gui', nna_integration_protocol: '1.0', version: '20261006-3' }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'nnd-local',
    nnd_version: '20261006-3' }));
  await mkdir(join(root, 'packages', 'electron', 'dist-server'), { recursive: true });
  await writeFile(join(root, 'packages', 'electron', 'dist-server', 'server.mjs'), 'export {};\n');
  await mkdir(join(root, 'packages', 'web', 'dist'), { recursive: true });
  await writeFile(join(root, 'packages', 'web', 'dist', 'index.html'), '<html></html>');
  return root;
};

test('package actions reuse the CLI registry verbatim through the http surface', async () => {
  const root = await scratch();
  const config = join(root, 'config');
  const packageRoot = await validPackageRoot(join(root, 'desktop-app'));
  try {
    const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
      host: '127.0.0.1', port: 0,
      resolvePrincipal: () => ({ subjectId: 'operator@example.com',
        permissions: ['nnd.package.manage', 'nnd.configuration.read'] }),
      nndPackageActionsService: createNndPackageActionsService({ rootPath: root, configPath: config,
        installationId: identity.installation_id, dataId: identity.data_id }) });
    try {
      const read = async (path, method = 'GET', body, bearer = token) => {
        const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' } });
        return { status: response.status, body: await response.json().catch(() => null) };
      };
      const absent = await read('/v1/nnd/configuration/nnd-package');
      assert.equal(absent.status, 200);
      assert.deepEqual(absent.body.package, { registered: false });
      assert.equal(absent.body.action, 'status');
      assert.equal(absent.body.application, 'not_applied');
      const activated = await read('/v1/nnd/configuration/nnd-package/actions/activate', 'POST',
        { root: packageRoot });
      assert.equal(activated.status, 200);
      assert.deepEqual(activated.body.package, { registered: true, root: packageRoot,
        version: '20261006-3', valid: true });
      assert.equal(activated.body.action, 'activate');
      assert.equal(activated.body.application, 'registered_root');
      const status = await read('/v1/nnd/configuration/nnd-package');
      assert.equal(status.body.package.registered, true);
      assert.equal(status.body.package.valid, true);
      await mkdir(join(root, 'actually-not-the-package'));
      const deactivated = await read('/v1/nnd/configuration/nnd-package/actions/deactivate', 'POST',
        { root: join(root, 'actually-not-the-package') });
      assert.equal(deactivated.status, 400);
      assert.equal(deactivated.body.error.code, 'nnd_package_root_mismatch');
      const gone = await read('/v1/nnd/configuration/nnd-package/actions/deactivate', 'POST',
        { root: packageRoot });
      assert.equal(gone.status, 200);
      assert.deepEqual(gone.body.package, { registered: false });
      assert.equal(gone.body.action, 'deactivate');
      assert.equal((await read('/v1/nnd/configuration/nnd-package', 'POST')).status, 405);
      assert.equal((await read('/v1/nnd/configuration/nnd-package/actions/nothing', 'POST',
        { root: packageRoot })).status, 404);
      assert.equal((await read('/v1/nnd/configuration/nnd-package/actions/activate', 'POST')).status, 400);
    } finally {
      server.server.closeAllConnections();
      await server.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
