// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureInitialProvider, discoverProviderModels, loadManagedProviderCredentials, providerBootstrapStatus,
} from '../src/provider/bootstrap.js';

test('installer provider bootstrap discovers, persists, injects, and then skips an existing profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-bootstrap-'));
  const paths = { config: join(root, 'config'), providerCredentials: join(root, 'config', 'provider-credentials.json') };
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
  assert.equal(manifest.providers[0].credential_env, 'NNA_PROVIDER_INITIAL_KEY');
  assert.doesNotMatch(JSON.stringify(manifest), /private-key/u);
  const environment = {};
  assert.equal(await loadManagedProviderCredentials(paths, environment), 1);
  assert.equal(environment.NNA_PROVIDER_INITIAL_KEY, 'private-key');
  assert.deepEqual(await providerBootstrapStatus(paths), { configured: true, count: 1 });
  assert.equal((await configureInitialProvider(paths, { endpoint: 'http://elsewhere/v1', model: 'other', key: '' })).skipped, true);
  delete process.env.NNA_PROVIDER_INITIAL_KEY;
});

test('installer provider bootstrap supports providers without authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-provider-no-key-'));
  const paths = { config: join(root, 'config'), providerCredentials: join(root, 'config', 'provider-credentials.json') };
  const configured = await configureInitialProvider(paths, {
    endpoint: 'http://localhost:1234', model: 'local-model', key: '',
  });
  assert.equal(configured.endpoint, 'http://localhost:1234/v1');
  const manifest = JSON.parse(await readFile(join(paths.config, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers[0].credential_env, undefined);
  assert.equal(await loadManagedProviderCredentials(paths, {}), 0);
});

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
