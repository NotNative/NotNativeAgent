// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureInitialProvider, discoverProviderModels, loadManagedProviderCredentials, providerBootstrapStatus,
} from '../src/provider/bootstrap.js';

test('installer provider bootstrap discovers, encrypts, binds, and then skips an existing profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-bootstrap-'));
  const paths = providerPaths(root);
  assert.deepEqual(await providerBootstrapStatus(paths), { configured: false });
  const models = await discoverProviderModels('http://127.0.0.1:1234/v1/', 'private-key', {
    fetch: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:1234/v1/models');
      assert.equal(init.headers.authorization, 'Bearer private-key');
      return new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }));
    },
  });
  assert.deepEqual(models, ['a-model', 'z-model']);
  const configured = await configureInitialProvider(paths, {
    endpoint: 'http://127.0.0.1:1234/v1/', model: models[0], key: 'private-key',
  });
  assert.equal(configured.authenticated, true);
  const manifest = JSON.parse(await readFile(join(paths.config, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers[0].model, 'a-model');
  assert.equal(manifest.providers[0].credential.source, 'secret');
  assert.equal(manifest.providers[0].credential.field, 'api_key');
  assert.doesNotMatch(JSON.stringify(manifest), /private-key/u);
  const vaultText = await readFile(paths.secretVault, 'utf8');
  assert.doesNotMatch(vaultText, /private-key/u);
  assert.equal(JSON.parse(vaultText).records[0].label, 'a-model-Provider');
  assert.equal(await loadManagedProviderCredentials(paths, {}), 0);
  assert.deepEqual(await providerBootstrapStatus(paths), { configured: true, count: 1 });
  assert.equal((await configureInitialProvider(paths, { endpoint: 'http://elsewhere/v1', model: 'other', key: '' })).skipped, true);
});

test('installer provider bootstrap supports providers without authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-no-key-'));
  const paths = providerPaths(root);
  const configured = await configureInitialProvider(paths, {
    endpoint: 'http://localhost:1234', model: 'local-model', key: '',
  });
  assert.equal(configured.endpoint, 'http://localhost:1234/v1');
  const manifest = JSON.parse(await readFile(join(paths.config, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers[0].credential_env, undefined);
  assert.equal(await loadManagedProviderCredentials(paths, {}), 0);
});

test('provider credentials publish atomically and malformed JSON is quarantined with an actionable path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-atomic-'));
  const paths = providerPaths(root);
  await configureInitialProvider(paths, { endpoint: 'http://localhost:1234', model: 'local-model', key: 'private-key' });
  assert.equal((await readdir(paths.config)).some((name) => name.includes('.tmp-')), false);
  await writeFile(paths.providerCredentials, '{"format_version":', 'utf8');
  await assert.rejects(loadManagedProviderCredentials(paths, {}), (error) => {
    assert.equal(error.code, 'provider_credentials_invalid');
    assert.match(error.message, /provider credential store is malformed; preserved at .*\.corrupt-\d+/u);
    return true;
  });
  const names = await readdir(paths.config);
  assert.equal(names.includes('provider-credentials.json'), false);
  assert.equal(names.filter((name) => /^provider-credentials\.json\.corrupt-\d+$/u.test(name)).length, 1);
});

function providerPaths(root) {
  return {
    config: join(root, 'config'), providerCredentials: join(root, 'config', 'provider-credentials.json'),
    secretVault: join(root, 'config', 'secrets.json'), secretKey: join(root, 'config', 'secret.key'),
    secretAudit: join(root, 'config', 'secret-audit.jsonl'),
  };
}

test('installer sources expose idempotent interactive provider setup', async () => {
  const root = new URL('../', import.meta.url);
  const windows = await readFile(new URL('install.ps1', root), 'utf8');
  const posix = await readFile(new URL('install.sh', root), 'utf8');
  for (const source of [windows, posix]) {
    assert.match(source, /provider status/u);
    assert.match(source, /provider discover/u);
    assert.match(source, /provider configure/u);
    assert.match(source, /Choose a model by number or exact model name/u);
    assert.match(source, /Provider profile already configured/u);
  }
});
