// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInitialProvider } from '../src/provider/bootstrap.js';
import { ProviderProfileStore } from '../src/provider/profile-store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), '.nna-manifest-consumer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { config: root, secretVault: join(root, 'secrets.json'), secretKey: join(root, 'secret.key'),
    secretAudit: join(root, 'secret-audit.jsonl') };
}

test('competing bootstrap writers publish one profile and create one referenced secret', async t => {
  const paths = await fixture(t);
  const results = await Promise.all(['first', 'second'].map(model => configureInitialProvider(paths, {
    endpoint: 'http://127.0.0.1:1234/v1', model, key: `${model}-private-key`,
  })));
  assert.equal(results.filter(result => !result.skipped).length, 1);
  const manifest = JSON.parse(await fs.readFile(join(paths.config, 'manifest.json'), 'utf8'));
  const vault = JSON.parse(await fs.readFile(paths.secretVault, 'utf8'));
  assert.equal(vault.records.length, 1);
  assert.equal(manifest.providers[0].credential.secret_id, vault.records[0].id);
});

test('publication uncertainty after initial link preserves the committed credential', async t => {
  const paths = await fixture(t), path = join(paths.config, 'manifest.json');
  const original = fs.link;
  fs.link = async (from, to) => {
    await original(from, to);
    if (to === path) throw Object.assign(new Error('Lost publication acknowledgement'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  try {
    const result = await configureInitialProvider(paths, {
      endpoint: 'http://127.0.0.1:1234/v1', model: 'winner', key: 'private-key',
    });
    assert.equal(result.configured, true);
  } finally { fs.link = original; syncBuiltinESMExports(); }
  const manifest = JSON.parse(await fs.readFile(path, 'utf8'));
  const vault = JSON.parse(await fs.readFile(paths.secretVault, 'utf8'));
  assert.equal(vault.records.length, 1);
  assert.equal(manifest.providers[0].credential.secret_id, vault.records[0].id);
  assert.equal((await fs.stat(path)).nlink, 1);
});

test('independent profile stores retain both edits without materializing unrelated defaults', async t => {
  const paths = await fixture(t), path = join(paths.config, 'manifest.json');
  const raw = { provider: { id: 'original', endpoint: 'http://127.0.0.1:1234/v1', model: 'base', trust_zone: 'loopback' },
    memory: { enabled: false } };
  await fs.writeFile(path, JSON.stringify(raw));
  const first = new ProviderProfileStore({ path }), second = new ProviderProfileStore({ path });
  await Promise.all([
    first.update('original', { model: 'changed' }),
    second.create({ profile_id: 'added', endpoint: 'http://127.0.0.1:5678/v1', model: 'new' }),
  ]);
  const saved = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(saved.providers.find(provider => provider.id === 'original').model, 'changed');
  assert.equal(saved.providers.find(provider => provider.id === 'added').model, 'new');
  assert.deepEqual(saved.memory, raw.memory);
  assert.equal(saved.provider_timeout_ms, undefined);
  assert.equal(saved.tui, undefined);
  assert.equal(saved.providers.find(provider => provider.id === 'original').tool_call_mode, undefined);
});
