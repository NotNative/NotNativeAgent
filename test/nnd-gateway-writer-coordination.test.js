// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { runGatewayCommand } from '../src/gateway-cli.js';
import { createNndGatewayTimeoutTransaction } from '../src/nnd-gateway-timeout-transaction.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';

const principal = { subjectId: 'operator', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nnd-gateway-writer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'); await mkdir(config);
  const path = join(config, 'gateway.json');
  await writeFile(path, JSON.stringify({ version: 1, enabled: false, token: 'private-telegram-token-value',
    authorized_user_ids: ['11'], polling_timeout_seconds: 25, future_private_key: 'keep-me' }));
  const service = createNndGatewayTimeoutTransaction({ path, installationId: 'install_test', dataId: 'data_test' });
  return { path, paths: { gatewayConfig: path }, service };
}
function request(revision, operationId) {
  return { installation_id: 'install_test', data_id: 'data_test', scope: 'user', expected_revision: revision,
    expected_resolution_revision: revision, polling_timeout_seconds: 30, operation_id: operationId };
}
test('two concurrent CLI authorizations serialize and retain both users and private fields', async t => {
  const f = await fixture(t);
  const results = await Promise.all([runGatewayCommand(['authorize', '22'], f.paths), runGatewayCommand(['authorize', '33'], f.paths)]);
  assert.equal(results.every(result => result.config.authorized_user_ids.includes('11')), true);
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(stored.authorized_user_ids, ['11', '22', '33']);
  assert.equal(stored.token, 'private-telegram-token-value');
  assert.equal(stored.future_private_key, 'keep-me');
  assert.equal(JSON.stringify(results).includes('private-telegram-token-value'), false);
});
test('CLI update racing native CAS either preserves saved timeout or forces stale conflict', async t => {
  const f = await fixture(t), read = await f.service.read(principal);
  let release; const held = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const owner = withManifestLock(f.path, {}, async () => { entered(); await held; });
  await started;
  const native = f.service.save(principal, request(read.source_revision, 'timeout_race'));
  const cli = runGatewayCommand(['authorize', '22'], f.paths);
  release(); await owner;
  const [nativeResult, cliResult] = await Promise.allSettled([native, cli]);
  assert.equal(cliResult.status, 'fulfilled');
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(stored.authorized_user_ids, ['11', '22']);
  assert.equal(stored.token, 'private-telegram-token-value');
  assert.equal(stored.future_private_key, 'keep-me');
  if (nativeResult.status === 'fulfilled') {
    assert.equal(nativeResult.value.persistence, 'saved');
    assert.equal(stored.polling_timeout_seconds, 30);
    assert.equal((await f.service.operation(principal, 'timeout_race')).persistence, 'saved');
  } else {
    assert.equal(nativeResult.reason.code, 'manifest_revision_conflict');
    assert.equal(stored.polling_timeout_seconds, 25);
    assert.equal(await f.service.operation(principal, 'timeout_race'), null);
  }
});
test('CLI update refuses malformed source without repairing or disclosing its bytes', async t => {
  const f = await fixture(t);
  await writeFile(f.path, '{private-token:do-not-print');
  await assert.rejects(runGatewayCommand(['authorize', '22'], f.paths), error => {
    assert.equal(error.code, 'gateway_config_invalid');
    assert.equal(String(error.message).includes('private-token'), false);
    return true;
  });
  assert.equal(await readFile(f.path, 'utf8'), '{private-token:do-not-print');
});
