// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIGURATION_KEYS, MANIFEST_KEYS, MANIFEST_SHAPE_DESCRIPTORS } from '../src/configuration-keys.js';
import { validateNestedManifestKeys } from '../src/configuration-shape.js';
import { ROLES } from '../src/contracts.js';
import { DEFAULT_KEY_BINDINGS, validateKeyBindings } from '../src/experience/key-bindings.js';
import { resolveManifest } from '../src/config.js';

test('configuration structural descriptors are immutable and reuse role and binding owners', () => {
  assert.equal(CONFIGURATION_KEYS.manifest, MANIFEST_KEYS);
  assert.equal(CONFIGURATION_KEYS.roles, ROLES);
  assert.deepEqual(CONFIGURATION_KEYS.keyBindings, Object.keys(DEFAULT_KEY_BINDINGS));
  assert.equal(CONFIGURATION_KEYS.keyBindings.length, 17);
  assert.ok(Object.isFrozen(CONFIGURATION_KEYS));
  assert.ok(Object.isFrozen(MANIFEST_SHAPE_DESCRIPTORS));
  for (const keys of Object.values(CONFIGURATION_KEYS)) {
    assert.ok(Object.isFrozen(keys));
    assert.equal(new Set(keys).size, keys.length);
    assert.throws(() => keys.push('future_field'), TypeError);
  }
  const paths = new Set();
  for (const descriptor of MANIFEST_SHAPE_DESCRIPTORS) {
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(!paths.has(descriptor.path));
    paths.add(descriptor.path);
    assert.equal(descriptor.keys, descriptor.family ? CONFIGURATION_KEYS[descriptor.family] : null);
  }
  assert.deepEqual(new Set(MANIFEST_SHAPE_DESCRIPTORS.map(({ family }) => family).filter(Boolean)), new Set(Object.keys(CONFIGURATION_KEYS)));
});

test('every nested key family preserves benign warnings and security rejection at concrete paths', () => {
  const descriptors = MANIFEST_SHAPE_DESCRIPTORS.filter(({ validator }) => validator === 'validateNestedManifestKeys');
  for (const descriptor of descriptors) {
    const { manifest, target, path } = objectAt(descriptor.path);
    target.future_hint = true;
    assert.deepEqual(validateNestedManifestKeys(manifest), [`unknown manifest key ignored: ${path}.future_hint`]);
    delete target.future_hint;
    target.future_secret = 'private-value';
    assert.throws(() => validateNestedManifestKeys(manifest), (error) => {
      assert.equal(error.code, 'unknown_security_key');
      assert.equal(error.configurationKey, `${path}.future_secret`);
      assert.ok(!error.message.includes('private-value'));
      return true;
    });
  }
});

test('shape descriptors distinguish finite roles, collection identities, alternatives and dynamic names', () => {
  const byPath = new Map(MANIFEST_SHAPE_DESCRIPTORS.map((entry) => [entry.path, entry]));
  assert.equal(byPath.get('provider').alternative, 'providers[*]');
  assert.equal(byPath.get('providers[*]').alternative, 'provider');
  assert.equal(byPath.get('routes.{role}').names, ROLES);
  for (const path of ['providers[*]', 'mcp_servers[*]', 'skills[*]']) {
    assert.equal(byPath.get(path).kind, 'collection');
    assert.equal(byPath.get(path).identity, 'id');
  }
  for (const path of ['mcp_servers[*].header_env', 'mcp_servers[*].header_credentials', 'mcp_servers[*].tool_effects']) {
    assert.equal(byPath.get(path).kind, 'dynamic-map');
    assert.equal(byPath.get(path).keys, null);
  }
  assert.deepEqual(validateNestedManifestKeys({ mcp_servers: [{ header_env: { X_Secret: 'TOKEN' }, tool_effects: { authenticated_tool: 'read_only' } }] }), []);
});

test('extraction preserves malformed shape warning order and key-binding owner rejection', () => {
  assert.deepEqual(validateNestedManifestKeys({
    provider: null, providers: [null], routes: { future_hint: true, primary: [] },
    attachments: [], mcp_servers: [{ header_env: [], tool_effects: [] }], mission: { bounds: [] },
  }), [
    'unknown manifest shape ignored: provider', 'unknown manifest shape ignored: providers[0]',
    'unknown manifest key ignored: routes.future_hint', 'unknown manifest shape ignored: routes.primary',
    'unknown manifest shape ignored: attachments', 'unknown manifest shape ignored: mcp_servers[0].header_env',
    'unknown manifest shape ignored: mcp_servers[0].tool_effects', 'unknown manifest shape ignored: mission.bounds',
  ]);
  assert.deepEqual(validateNestedManifestKeys({ tui: { key_bindings: { future_hint: 'ctrl+a' } } }), []);
  assert.throws(() => validateKeyBindings({ future_hint: 'ctrl+a' }), { code: 'key_unsupported' });
  assert.throws(() => validateNestedManifestKeys({ provider: { credential: { secretId: 'sec_a' } } }), { code: 'unknown_security_key' });
});

test('top-level canonical keys still classify unknown extension and security fields', () => {
  const provider = { endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
  assert.equal(MANIFEST_KEYS.length, 38);
  const config = resolveManifest({ provider, future_hint: true });
  assert.deepEqual(config.warnings, ['unknown manifest key ignored: future_hint']);
  assert.throws(() => resolveManifest({ provider, future_security: true }), { code: 'unknown_security_key' });
  assert.deepEqual(resolveManifest({ provider, future_secret: true }).warnings, ['unknown manifest key ignored: future_secret']);
});

function objectAt(template) {
  const manifest = {};
  let target = manifest;
  const path = [];
  for (const component of template.split('.')) {
    const name = component === '{role}' ? 'primary' : component === '{header}' ? 'X-Example' : component.replace('[*]', '');
    const child = {};
    target[name] = component.endsWith('[*]') ? [child] : child;
    target = child;
    path.push(component.endsWith('[*]') ? `${name}[0]` : name);
  }
  return { manifest, target, path: path.join('.') };
}
