// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStatusEnvelope, isExecutionGuarded, NND_SERVICE_STATES } from '../src/nnd-service-contract.js';
import { validateNndManifestExtensions, assertNndActivationCompatibility } from '../src/nnd-manifest-extensions.js';

function manifest() {
  return {
    id: 'nnd-local', ownership: 'nnd', scope: 'local-gui', nna_integration_protocol: '1.0', version: '20261001-42',
    service_activation: {
      schema_version: '1.0', required_capabilities: ['service_supervision', 'setup_control_plane'],
      data_schemas: { nnd_catalog: 1, nnd_state: 1 }, platform: 'win32', architecture: 'x64',
      runtime: { name: 'node', minimum_major: 24 }, entrypoint: 'scripts/serve-installed.mjs',
      bundle_identity: { path: 'packages/electron/dist-server/server.mjs', sha256: 'a'.repeat(64) },
      authenticated_callbacks: { token_exchange: 'protected_stdin', protocol: '1.0' },
    },
  };
}
function host() {
  return { platform: 'win32', architecture: 'x64', node_major: 24,
    capabilities: ['service_supervision', 'setup_control_plane'], data_schemas: { nnd_catalog: 1, nnd_state: 1 } };
}
function status() {
  return {
    service_state: 'ready', failure_code: null, installation_id: 'install_1', data_id: 'data_1',
    instance_id: 'generation_1', endpoint: 'http://127.0.0.1:3000', package_version: '20261001-42',
    protocol: '1.0', runtime_state: 'ready', package_state: 'ready', provider_state: 'ready', setup_guidance: null,
  };
}
test('unknown lifecycle values fail closed without coercion', () => {
  for (const state of [...NND_SERVICE_STATES.filter((entry) => entry !== 'ready'), null, undefined, {}, 'READY']) {
    assert.equal(isExecutionGuarded(state), true);
  }
  assert.equal(isExecutionGuarded('ready'), false);
});
test('status validates complete readiness and separates provider setup from transport', () => {
  assert.equal(assertStatusEnvelope(status()).service_state, 'ready');
  const setup = { ...status(), service_state: 'setup_required', failure_code: 'nnd_setup_required',
    provider_state: 'setup_required', setup_guidance: 'Configure the primary and reviewer routes.' };
  assert.equal(assertStatusEnvelope(setup).runtime_state, 'ready');
  assert.equal(isExecutionGuarded(setup.service_state), true);
  assert.throws(() => assertStatusEnvelope({ ...setup, provider_state: 'ready' }), /setup prerequisites/u);
});
test('status refuses malformed identities, unknown protocol, secrets and unsafe endpoint forms', () => {
  for (const patch of [
    { installation_id: null }, { data_id: {} }, { instance_id: '' }, { instance_id: null },
    { installation_id: 'x'.repeat(129) }, { protocol: '2.0' }, { package_version: 20261001 },
    { package_version: '20261001-0' }, { package_version: null }, { provider_state: 'unknown' },
    { runtime_state: 'starting' }, { package_state: 'absent' }, { failure_code: 'nnd_service_crashed' },
    { setup_guidance: 'Unexpected setup' }, { secret: 'do not expose' }, { endpoint: null },
  ]) assert.throws(() => assertStatusEnvelope({ ...status(), ...patch }));
  for (const endpoint of [
    'http://localhost:3000', 'http://127.1:3000', 'http://2130706433:3000', 'https://127.0.0.1:3000',
    'http://0.0.0.0:3000', 'http://127.0.0.1:3000/?token=secret', 'http://127.0.0.1:3000/#secret',
    'http://user:secret@127.0.0.1:3000', 'http://127.0.0.1:3000/path', 'http://127.0.0.1:0', {},
  ]) assert.throws(() => assertStatusEnvelope({ ...status(), endpoint }), JSON.stringify(endpoint));
  assert.doesNotThrow(() => assertStatusEnvelope({ ...status(), endpoint: 'http://[::1]:3000' }));
  for (const port of [80, 65535]) {
    assert.doesNotThrow(() => assertStatusEnvelope({ ...status(), endpoint: `http://127.0.0.1:${port}` }));
  }
  for (const port of ['65536', '080']) {
    assert.throws(() => assertStatusEnvelope({ ...status(), endpoint: `http://127.0.0.1:${port}` }));
  }
});
test('non-live status cannot publish an endpoint and failures require actionable bounded guidance', () => {
  const failed = { ...status(), service_state: 'failed', endpoint: null, runtime_state: 'failed',
    failure_code: 'nnd_service_crashed', setup_guidance: 'Restart the NND service.' };
  assert.doesNotThrow(() => assertStatusEnvelope(failed));
  for (const patch of [{ endpoint: status().endpoint }, { setup_guidance: null }, { setup_guidance: '' },
    { setup_guidance: 'x'.repeat(1025) }, { setup_guidance: 'bad\ncontrol' }, { failure_code: null },
    { failure_code: 'invented' }]) assert.throws(() => assertStatusEnvelope({ ...failed, ...patch }));
  const inherited = Object.create(status());
  assert.throws(() => assertStatusEnvelope(inherited));
});
test('activation schema is pure and does not advertise runtime capabilities', () => {
  const value = manifest();
  const before = structuredClone(value);
  assert.equal(validateNndManifestExtensions(value), value);
  assert.deepEqual(value, before);
  assert.throws(() => assertNndActivationCompatibility(value, undefined), { code: 'nnd_package_incompatible' });
  assert.throws(() => assertNndActivationCompatibility(value, { ...host(), capabilities: [] }), { code: 'nnd_package_incompatible' });
  assert.equal(assertNndActivationCompatibility(value, host()), value);
});
test('activation refuses missing requirements, unsupported schemas, unsafe paths and circular release digest', () => {
  const changes = [
    (v) => { v.required_capabilities = []; },
    (v) => { v.required_capabilities = ['service_supervision']; },
    (v) => { v.required_capabilities.push('service_supervision'); },
    (v) => { v.data_schemas.nnd_catalog = 2; },
    (v) => { v.data_schemas = {}; },
    (v) => { v.architecture = 'ia32'; },
    (v) => { v.platform = 'linux'; },
    (v) => { v.runtime.minimum_major = '24'; },
    (v) => { v.runtime.minimum_major = 22; },
    (v) => { v.runtime.name = 'bun'; },
    (v) => { v.schema_version = '2.0'; },
    (v) => { v.bundle_identity.sha256 = 'z'.repeat(64); },
    (v) => { v.bundle_identity.path = 'RELEASE_MANIFEST.sha256'; },
    (v) => { v.authenticated_callbacks.token_exchange = 'environment'; },
    (v) => { v.authenticated_callbacks.protocol = '2.0'; },
    (v) => { v.extra = true; },
  ];
  for (const path of ['../escape.mjs', 'C:/escape.mjs', '/escape.mjs', 'scripts\\escape.mjs', 'foo//bar.mjs', 'file:bad.mjs']) {
    changes.push((v) => { v.entrypoint = path; });
    changes.push((v) => { v.bundle_identity.path = path; });
  }
  for (const mutate of changes) {
    const value = manifest();
    mutate(value.service_activation);
    assert.throws(() => validateNndManifestExtensions(value), { code: 'nnd_package_manifest_invalid' });
  }
  for (const patch of [{ id: 'other' }, { version: null }, { scope: 'remote' }, { service_activation: undefined }]) {
    assert.throws(() => validateNndManifestExtensions({ ...manifest(), ...patch }), { code: 'nnd_package_manifest_invalid' });
  }
});
test('host comparison rejects unknown required capabilities and incompatible runtime or store formats', () => {
  const future = manifest();
  future.service_activation.required_capabilities.push('future_capability');
  assert.throws(() => assertNndActivationCompatibility(future, host()), { code: 'nnd_package_incompatible' });
  for (const patch of [{ platform: 'linux' }, { architecture: 'arm64' }, { node_major: 23 },
    { node_major: '24' }, { data_schemas: { nnd_catalog: 2, nnd_state: 1 } }, { capabilities: null }]) {
    assert.throws(() => assertNndActivationCompatibility(manifest(), { ...host(), ...patch }), { code: 'nnd_package_incompatible' });
  }
});
