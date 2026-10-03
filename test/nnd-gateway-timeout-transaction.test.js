// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createNndGatewayTimeoutTransaction } from '../src/nnd-gateway-timeout-transaction.js';
import { loadGatewayConfig } from '../src/gateway/config.js';
import { readManifestSnapshot } from '../src/persistence/manifest-transaction.js';

const read = { subjectId: 'operator', permissions: ['nnd.configuration.read'] };
const manage = { subjectId: 'operator', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nnd-gateway-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config'); await mkdir(config);
  const path = join(config, 'gateway.json');
  const raw = { version: 1, enabled: false, token: 'very-private-bot-token-value', token_env: 'NNA_TELEGRAM_BOT_TOKEN',
    authorized_user_ids: ['123456789'], workspace_root: null, polling_timeout_seconds: 25,
    future_private_key: { secret: 'keep-me' } };
  await writeFile(path, `${JSON.stringify(raw)}\n`);
  const service = createNndGatewayTimeoutTransaction({ path, installationId: 'install_test', dataId: 'data_test' });
  return { path, raw, service };
}
function request(revision, operationId = undefined) {
  return { installation_id: 'install_test', data_id: 'data_test', scope: 'user', expected_revision: revision,
    expected_resolution_revision: revision, polling_timeout_seconds: 30,
    ...(operationId ? { operation_id: operationId } : {}) };
}
test('private timeout transaction preserves raw token and unknown fields without projecting them', async t => {
  const f = await fixture(t), before = await f.service.read(read);
  assert.equal(before.polling_timeout_seconds, 25);
  assert.equal(JSON.stringify(before).includes('very-private'), false);
  const preview = await f.service.preview(manage, request(before.source_revision));
  assert.equal(preview.polling_timeout_seconds, 30);
  assert.equal(preview.application, 'not_applied');
  const receipt = await f.service.save(manage, request(before.source_revision, 'change_one'));
  assert.equal(receipt.persistence, 'saved'); assert.equal(receipt.application, 'not_applied');
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.token, f.raw.token); assert.deepEqual(stored.future_private_key, f.raw.future_private_key);
  assert.equal(stored.polling_timeout_seconds, 30);
  assert.equal((await f.service.operation(read, 'change_one')).persisted_revision, receipt.persisted_revision);
  assert.equal((await f.service.save(manage, request(before.source_revision, 'change_one'))).replayed, true);
});
test('permission, selected identity, stale CAS and malformed source refuse changes', async t => {
  const f = await fixture(t), before = await f.service.read(read);
  await assert.rejects(f.service.preview(read, request(before.source_revision)));
  await assert.rejects(f.service.save(read, request(before.source_revision, 'denied')));
  await assert.rejects(f.service.preview(manage, { ...request(before.source_revision), data_id: 'other' }));
  await assert.rejects(f.service.preview(manage, { ...request(before.source_revision), expected_resolution_revision: 'absent' }));
  await f.service.save(manage, request(before.source_revision, 'first'));
  await assert.rejects(f.service.save(manage, request(before.source_revision, 'stale')), { code: 'manifest_revision_conflict' });
  await writeFile(f.path, '{private-invalid-token');
  const current = await readManifestSnapshot(f.path);
  await assert.rejects(f.service.preview(manage, request(current.revision)), { code: 'nnd_gateway_timeout_source_invalid' });
  await assert.rejects(f.service.save(manage, request(current.revision, 'invalid')));
  assert.equal(await readFile(f.path, 'utf8'), '{private-invalid-token');
});
test('native principal subject IDs retain their admitted shape in private receipts', async t => {
  const f = await fixture(t);
  const actor = { subjectId: 'operator@example.com', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
  const before = await f.service.read(actor);
  const saved = await f.service.save(actor, request(before.source_revision, 'email_actor'));
  assert.equal(saved.persistence, 'saved');
  assert.equal((await f.service.operation(actor, 'email_actor')).persisted_revision, saved.persisted_revision);
  assert.equal(await f.service.operation(read, 'email_actor'), null);
});
test('transaction refuses output beyond the gateway loader bound before publishing', async t => {
  const f = await fixture(t);
  const raw = { ...f.raw, future_private_key: { secret: 'x'.repeat(65_100) } };
  while (Buffer.byteLength(`${JSON.stringify(raw, null, 2)}\n`) <= 65_536) raw.future_private_key.secret += 'x';
  assert.ok(Buffer.byteLength(`${JSON.stringify(raw)}\n`) <= 65_536);
  await writeFile(f.path, `${JSON.stringify(raw)}\n`);
  assert.equal((await loadGatewayConfig(f.path)).polling_timeout_seconds, 25);
  const before = await f.service.read(read);
  await assert.rejects(f.service.preview(manage, request(before.source_revision)), { code: 'nnd_gateway_timeout_source_invalid' });
  await assert.rejects(f.service.save(manage, request(before.source_revision, 'too_large')), { code: 'manifest_validation_failed' });
  assert.equal(await readFile(f.path, 'utf8'), `${JSON.stringify(raw)}\n`);
  await writeFile(f.path, `${JSON.stringify({ ...raw, future_private_key: { secret: 'x'.repeat(66_000) } })}\n`);
  const oversize = await readManifestSnapshot(f.path);
  await assert.rejects(f.service.read(read), { code: 'nnd_gateway_timeout_source_invalid' });
  await assert.rejects(f.service.preview(manage, request(oversize.revision)), { code: 'nnd_gateway_timeout_source_invalid' });
});
