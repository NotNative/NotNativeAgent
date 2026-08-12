// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { applyLaunchProviderOverrides } from '../src/launch-provider-overrides.js';

test('launch profile and model overrides are ephemeral and preserve saved configuration', () => {
  const original = configured();
  const selected = applyLaunchProviderOverrides(original, { providerProfile: 'remote', model: 'temporary-model' });
  assert.equal(selected.routes.primary.providerId, 'remote');
  assert.equal(selected.routes.primary.model, 'temporary-model');
  assert.deepEqual(selected.launchOverrides, {
    ephemeral: true, source: 'command_line', providerProfile: 'remote', endpoint: null,
    model: 'temporary-model', credentialReference: false,
  });
  assert.equal(original.routes.primary.providerId, 'local');
  assert.equal(original.routes.primary.model, 'local-model');
});

test('endpoint overrides require an explicit model and store only a credential reference', () => {
  const original = configured();
  assert.throws(() => applyLaunchProviderOverrides(original, { providerEndpoint: 'http://192.168.1.20:1234/v1' }), {
    code: 'provider_model_required',
  });
  const selected = applyLaunchProviderOverrides(original, {
    providerEndpoint: 'http://192.168.1.20:1234/v1', model: 'remote-model', providerCredentialEnv: 'NNA_REMOTE_TOKEN',
  });
  const profile = selected.providerProfiles[selected.routes.primary.providerId];
  assert.equal(profile.endpoint, 'http://192.168.1.20:1234/v1');
  assert.equal(profile.model, 'remote-model');
  assert.equal(profile.credentialEnv, 'NNA_REMOTE_TOKEN');
  assert.equal(selected.launchOverrides.credentialReference, true);
  assert.equal(original.providerProfiles['launch-override'], undefined);
});

test('launch profile selectors accept human labels and reject ambiguous labels', () => {
  const original = configured();
  const selected = applyLaunchProviderOverrides(original, { providerProfile: 'Remote Lab' });
  assert.equal(selected.routes.primary.providerId, 'remote');
  assert.throws(() => applyLaunchProviderOverrides(resolveManifest({
    providers: [
      { id: 'one', display_name: 'Duplicate', endpoint: 'http://127.0.0.1:1/v1', model: 'one', trust_zone: 'loopback' },
      { id: 'two', display_name: 'Duplicate', endpoint: 'http://127.0.0.1:2/v1', model: 'two', trust_zone: 'loopback' },
    ],
  }), { providerProfile: 'Duplicate' }), { code: 'provider_profile_ambiguous' });
});

function configured() {
  return resolveManifest({
    format_version: 1, persistence: 'ephemeral', workspace_root: process.cwd(),
    providers: [
      { id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'local-model', trust_zone: 'loopback' },
      { id: 'remote', display_name: 'Remote Lab', endpoint: 'http://192.168.1.10:1234/v1', model: 'remote-default', trust_zone: 'private_network' },
    ],
    routes: { primary: { provider_id: 'local', model: 'local-model' } },
  });
}
