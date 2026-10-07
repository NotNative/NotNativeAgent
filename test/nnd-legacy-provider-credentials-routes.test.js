// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNndLegacyProviderCredentialsService,
  projectLegacyProviderCredentials, dispatchNndLegacyProviderCredentialsRequest } from '../src/nnd-legacy-provider-credentials-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { ContractError } from '../src/ids.js';

const base = '/v1/nnd/configuration/legacy-provider-credentials';
const token = 'legacy-provider-token-32-characters-long-test';
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const paths = { providerCredentials: 'C:\\nna\\config\\provider-credentials.json' };

test('legacy credentials service loads the alias authority on a spare environment and projects the verdict without the value', async () => {
  const loaded = createNndLegacyProviderCredentialsService({ paths,
    installationId: 'install_legacy', dataId: 'data_legacy',
    loader: async (checkedPaths, environment) => { environment.NNA_PROVIDER_INITIAL_KEY = 'sk-super-secret';
      return 1; } });
  const receipt = await loaded.status();
  assert.deepEqual(Object.keys(receipt).sort(), ['count', 'data_id', 'installation_id',
    'loaded', 'reason', 'schema_version', 'scope']);
  assert.equal(receipt.loaded, true);
  assert.equal(receipt.count, 1);
  assert.equal(receipt.reason, null);
  assert.equal(JSON.stringify(receipt).includes('sk-super-secret'), false,
    'the projection must never carry the legacy key value');
  const projected = projectLegacyProviderCredentials(receipt);
  assert.equal(projected.loaded, true);
  const refused = await createNndLegacyProviderCredentialsService({ paths,
    installationId: 'install_legacy', dataId: 'data_legacy',
    loader: async () => { throw new ContractError('provider_credentials_invalid', 'bad shape'); } }).status();
  assert.deepEqual({ loaded: refused.loaded, count: refused.count, reason: refused.reason },
    { loaded: false, count: 0, reason: 'provider_credentials_invalid' });
  for (const drift of [null,
    { ...receipt, loaded: 'yes' },
    { ...receipt, count: 5 },
    { ...receipt, reason: 'mystery' },
    { ...receipt, extra: true },
    { ...receipt, loaded: false },
    { ...(await createNndLegacyProviderCredentialsService({ paths,
      installationId: 'install_legacy', dataId: 'data_legacy',
      loader: async () => { throw new ContractError('provider_bootstrap_file_too_large', 'too big'); } }).status()), reason: 'mystery' }]) {
    assert.throws(() => projectLegacyProviderCredentials(drift),
      (error) => error.code === 'nnd_legacy_provider_credentials_projection_invalid');
  }
  assert.throws(() => createNndLegacyProviderCredentialsService({ paths: {},
    installationId: 'install_legacy', dataId: 'data_legacy' }),
  { code: 'nnd_legacy_provider_credentials_request_invalid' });
  await assert.rejects(createNndLegacyProviderCredentialsService({ paths,
    installationId: 'install_legacy', dataId: 'data_legacy',
    loader: async () => { throw new ContractError('provider_bootstrap_file_invalid', 'invalid'); } }).status(),
  { code: 'provider_bootstrap_file_invalid' }, 'the registered authority refusal passes verbatim');
});

async function httpFixture(t, loader) {
  const impl = createNndLegacyProviderCredentialsService({ paths,
    installationId: 'install_legacy', dataId: 'data_legacy', loader });
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0,
    nndRuntime: { getHost: () => ({ workspaceRoot: 'C:\\workspace' }),
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED, nndLegacyProviderCredentialsService: impl });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  return async (suffix = '', { method = 'GET', bearer = token } = {}) => {
    const response = await fetch(endpoint + base + suffix, { method,
      headers: { authorization: bearer ? `Bearer ${bearer}` : '' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
}

test('legacy credentials HTTP serves the verdict with honest failure codes', async t => {
  const call = await httpFixture(t, async (checkedPaths, environment) => {
    environment.NNA_PROVIDER_INITIAL_KEY = 'sk-any'; return 1; });
  assert.equal((await call('', { bearer: null })).status, 401);
  assert.equal((await call('', { method: 'POST' })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
  const read = await call('?alias=1');
  assert.equal(read.status, 400, 'search-bearing requests fail closed');
  assert.equal(read.body?.error?.code, 'nnd_legacy_provider_credentials_request_invalid');
  const verdict = await call();
  assert.equal(verdict.status, 200);
  assert.equal(verdict.body.loaded, true);
  assert.equal(verdict.body.count, 1);
  assert.equal(verdict.body.reason, null);
  const absentCall = await httpFixture(t, async () => 0);
  const absent = await absentCall();
  assert.equal(absent.status, 200);
  assert.equal(absent.body.loaded, false);
  assert.equal(absent.body.count, 0);
  const refusedCall = await httpFixture(t, async () => {
    throw new ContractError('provider_credentials_invalid', 'bad shape'); });
  const refused = await refusedCall();
  assert.equal(refused.status, 200, 'the store refusal is a projected verdict, not a thrown failure');
  assert.equal(refused.body.loaded, false);
  assert.equal(refused.body.reason, 'provider_credentials_invalid');
});

test('legacy credentials unrelated paths return false for the router chain', async () => {
  assert.equal(await dispatchNndLegacyProviderCredentialsRequest({}, {},
    { url: new URL('http://x/other'), principal: PERMITTED }), false);
});
