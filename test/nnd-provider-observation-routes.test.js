// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNndProviderObservation } from '../src/nnd-provider-observation.js';
import { dispatchNndProviderObservationRequest } from '../src/nnd-provider-observation-routes.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';

const base = '/v1/nnd/configuration/provider-observations';
const token = 'provider-observation-http-test-token-32-char';
const PERMITTED = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read'] };
const LIMITED = { subjectId: 'limited@example.com', permissions: ['nnd.configuration.manage'] };
const IDENTITY = { installationId: 'install_test', dataId: 'data_test' };
const PATHS = ['providers[*].credential', 'providers[*].credential.source', 'providers[*].credential.name',
  'providers[*].credential.secret_id', 'providers[*].credential.field', 'providers[*].capabilities',
  'provider.credential', 'provider.credential_env', 'provider.capabilities', 'provider.credential.source',
  'provider.credential.name', 'provider.credential.secret_id', 'provider.credential.field'];
const ENTRY = ['id', 'model', 'endpoint', 'trust_zone', 'credential', 'credential_env', 'capabilities'];

const secretManifest = {
  provider: {
    id: 'remote', endpoint: 'https://models.example.test/v1', model: 'remote-model',
    trust_zone: 'public_network', capabilities: { tools: true, images: false },
    credential: { source: 'secret', secret_id: 'sec_provider', field: 'api_key' },
  },
};
const environmentManifest = {
  provider: { id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model',
    trust_zone: 'loopback', credential_env: 'LOCAL_PROVIDER_TOKEN' },
};
const present = (rawManifest) => async () => ({ state: 'present', revision: 'a'.repeat(64), rawManifest });
const missing = async () => ({ state: 'missing', rawManifest: null, revision: 'absent' });

const service = (readSnapshot, over = {}) => createNndProviderObservation({
  paths: { config: 'C:\\ProgramData\\NotNativeAgent\\config' }, ...IDENTITY, readSnapshot, ...over });

test('provider observation projects bindings and capability flags and never a credential value', async () => {
  const view = await service(present(secretManifest)).read(PERMITTED);
  assert.deepEqual(Object.keys(view), ['schema_version', 'installation_id', 'data_id', 'scope',
    'source_state', 'manifest_revision', 'providers']);
  assert.equal(view.source_state, 'present');
  assert.equal(view.manifest_revision, 'a'.repeat(64));
  assert.equal(view.providers.length, 1);
  assert.deepEqual(Object.keys(view.providers[0]), ENTRY);
  // The binding arrives through credentialManifest, so it carries only where
  // the credential lives: source, secret id and field, never the value itself.
  assert.deepEqual(view.providers[0].credential, { source: 'secret', secret_id: 'sec_provider', field: 'api_key' });
  assert.equal(view.providers[0].credential_env, null);
  assert.equal(view.providers[0].trust_zone, 'public_network');
  const flags = view.providers[0].capabilities;
  assert.deepEqual(Object.keys(flags), ['streaming', 'tools', 'images', 'structured_output', 'usage',
    'cancellation']);
  assert.equal(flags.streaming, true, 'NNA pins streaming true for every provider');
  assert.equal(flags.tools, true);
  assert.equal(flags.images, false);
  for (const name of Object.keys(flags)) assert.equal(typeof flags[name], 'boolean', name);

  // An environment binding shows the variable name and the compatibility alias
  // beside it; neither is a value, and the process environment is never read.
  const aliased = await service(present(environmentManifest)).read(PERMITTED);
  assert.deepEqual(aliased.providers[0].credential, { source: 'environment', name: 'LOCAL_PROVIDER_TOKEN' });
  assert.equal(aliased.providers[0].credential_env, 'LOCAL_PROVIDER_TOKEN');

  const absent = await service(missing).read(PERMITTED);
  assert.equal(absent.source_state, 'absent');
  assert.equal(absent.manifest_revision, 'absent');
  assert.deepEqual(absent.providers, []);
});

test('provider observation refuses a bad factory identity and a lesser principal before any disk work', async () => {
  assert.throws(() => createNndProviderObservation({ paths: {}, ...IDENTITY, readSnapshot: missing }),
    { code: 'nnd_provider_observation_request_invalid' });
  let reads = 0;
  const counted = async () => { reads += 1; return { state: 'missing', rawManifest: null, revision: 'absent' }; };
  await assert.rejects(service(counted).read(LIMITED), { code: 'integration_permission_denied' });
  assert.equal(reads, 0, 'the permission check runs before the manifest is opened');
});

async function fixture(t, providerObservationService) {
  const server = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    host: '127.0.0.1', port: 0, nndRuntime: { getHost: () => null,
      snapshot: () => ({ service_state: 'setup_required', execution_state: 'unavailable' }) },
    resolvePrincipal: () => PERMITTED,
    nndProviderObservationService: providerObservationService });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address.port}`;
  return async (suffix = '', { method = 'GET', bearer = token } = {}) => {
    const response = await fetch(endpoint + base + suffix,
      { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, body: await response.json() };
  };
}

test('provider HTTP serves the read and the catalog read-only and honours the permission', async t => {
  const call = await fixture(t, service(present(secretManifest)));
  assert.equal((await call('', { bearer: null })).status, 401);
  const read = await call();
  assert.equal(read.status, 200);
  assert.deepEqual(Object.keys(read.body), ['schema_version', 'installation_id', 'data_id', 'scope',
    'source_state', 'manifest_revision', 'providers']);
  assert.deepEqual(Object.keys(read.body.providers[0]), ENTRY);
  assert.equal((await call('', { method: 'POST', bearer: token })).status, 405, 'this family has no writes');
  assert.equal((await call('/unknown')).status, 404);
  const catalog = await call('/catalog');
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.fields.map((field) => field.path), PATHS);
  for (const field of catalog.body.fields) {
    assert.equal(field.application, 'not_applied');
    assert.deepEqual(field.editability, { available: false, scope: 'user',
      reason: 'manifest_transaction_owns_writes' });
    const credential = field.path.includes('credential');
    assert.equal(credential ? field.intent : undefined, credential ? 'credential_binding' : undefined);
    assert.equal(credential ? field.sensitivity : undefined, credential ? 'credential_reference' : undefined);
    assert.equal(field.classification, field.path.endsWith('.credential') || field.path.endsWith('.capabilities')
      ? 'container' : field.path.endsWith('credential_env') ? 'compatibility_alias' : 'operator_setting');
  }
});

test('provider HTTP passes manifest refusals through and treats projector drift as a server fault', async t => {
  const drifted = { id: 'remote', model: 'm', endpoint: 'http://127.0.0.1:1234/v1',
    trust_zone: 'loopback', credential: null, credential_env: null, capabilities: {
      streaming: true, tools: false, images: false, structured_output: false, usage: false,
      cancellation: false, unexpected: true } };
  const drifting = await fixture(t, { read: async () => ({ schema_version: '1.0',
    installation_id: 'install_test', data_id: 'data_test', scope: 'user', source_state: 'present',
    manifest_revision: 'absent', providers: [drifted] }) });
  const drift = await drifting();
  assert.equal(drift.status, 500, 'a value the projector cannot accept is a broken build, not a client error');
  assert.equal(drift.body.error.code, 'nnd_provider_observation_projection_invalid');

  const unresolvable = await fixture(t, service(present({ provider: { id: 'x',
    endpoint: 'http://127.0.0.1:1234/v1', model: 'm', trust_zone: 'public_network' } })));
  const refused = await unresolvable();
  assert.equal(refused.status, 400, 'the manifest speaks for itself through the resolver code');
  assert.equal(refused.body.error.code, 'invalid_trust_zone');
});

test('the route grammar refuses a query string, an unwired service, and unrelated paths', async () => {
  const response = { getHeader: () => undefined, setHeader: () => undefined };
  const context = (pathname, service2) => ({ url: new URL(`http://127.0.0.1${pathname}`),
    principal: PERMITTED, nndProviderObservationService: service2 });
  assert.equal(await dispatchNndProviderObservationRequest({ method: 'GET' }, response,
    context('/v1/nnd/configuration/installation', service(missing))), false,
  'an unrelated family is not ours to answer');

  const codes = [];
  const capture = async (pathname, service2) => {
    try {
      await dispatchNndProviderObservationRequest({ method: 'GET' }, response, context(pathname, service2));
    } catch (error) { codes.push(error.code); }
  };
  await capture('/v1/nnd/configuration/provider-observations?draft=1', service(missing));
  await capture('/v1/nnd/configuration/provider-observations', undefined);
  assert.deepEqual(codes, ['nnd_provider_observation_request_invalid', 'nnd_configuration_unavailable']);
});
