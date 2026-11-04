// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateManifestDocument, resolveManifest } from '../src/config.js';

const base = { format_version: 1 };

test('two models on one endpoint migrate to one connection and two selections', () => {
  const document = migrateManifestDocument({
    ...base,
    providers: [
      { id: 'big', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
      { id: 'fast', endpoint: 'http://127.0.0.1:1/v1', model: 'qwen', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'big' }, subagent: { provider_id: 'fast' } },
  }).manifest;
  assert.equal(document.format_version, 2);
  assert.equal(document.connections.length, 1);
  assert.equal(document.connections[0].endpoint, 'http://127.0.0.1:1/v1');
  assert.deepEqual(document.model_selections.map((item) => [item.id, item.model]),
    [['big', 'glm'], ['fast', 'qwen']]);
  assert.equal(document.routes.primary.selection_id, 'big');
  assert.equal(document.routes.subagent.selection_id, 'fast');
  // Why: the route names the model selection, and each selection still resolves to its own model.
  const config = resolveManifest(document);
  assert.equal(config.routes.primary.model, 'glm');
  assert.equal(config.routes.subagent.model, 'qwen');
  assert.equal(config.routes.subagent.providerId, 'fast');
});

test('two providers that differ in credential stay separate connections', () => {
  const document = migrateManifestDocument({
    ...base,
    providers: [
      { id: 'env', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback', credential_env: 'NNA_KEY' },
      { id: 'secret', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback',
        credential: { source: 'secret', secret_id: 'sec_one', field: 'api_key' } },
    ],
  }).manifest;
  // Why: collapsing these would drop one credential binding, so the migration keeps both.
  assert.equal(document.connections.length, 2);
  assert.equal(document.connections.find((item) => item.credential_env === 'NNA_KEY') !== undefined, true);
  assert.equal(document.connections.find((item) => item.credential?.secret_id === 'sec_one') !== undefined, true);
});

test('two providers on different endpoints stay separate connections', () => {
  const document = migrateManifestDocument({
    ...base,
    providers: [
      { id: 'lan', endpoint: 'http://192.168.1.1:1/v1', model: 'big', trust_zone: 'private_network' },
      { id: 'local', endpoint: 'http://127.0.0.1:2/v1', model: 'small', trust_zone: 'loopback' },
    ],
  }).manifest;
  assert.equal(document.connections.length, 2);
  assert.equal(document.connections.find((item) => item.id === 'lan').trust_zone, 'private_network');
});

test('a migrated document migrates once and keeps its identifiers', () => {
  const first = migrateManifestDocument({
    ...base,
    providers: [{ id: 'one', endpoint: 'http://127.0.0.1:1/v1', model: 'base', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'one' } },
  });
  assert.equal(first.migrated, true);
  assert.deepEqual(first.manifest.connections.map((item) => item.id), ['one']);
  const second = migrateManifestDocument(first.manifest);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.manifest.connections, first.manifest.connections);
  assert.deepEqual(second.manifest.model_selections, first.manifest.model_selections);
});

test('a malformed provider reaches the validator instead of being repaired', () => {
  // Why: an id that is not a safe bounded token is left in place, so the validator reports it rather
  // than the migration inventing a replacement identifier.
  assert.throws(() => resolveManifest({ ...base, providers: [{ id: 'bad id', endpoint: 'http://127.0.0.1:1/v1', model: 'x', trust_zone: 'loopback' }] }),
    { code: 'provider_id_invalid' });
  assert.throws(() => resolveManifest({ ...base, providers: [{ id: 'bad', endpoint: 'https://example.test/v1', model: 'x', trust_zone: 'loopback' }] }),
    { code: 'invalid_trust_zone' });
});
