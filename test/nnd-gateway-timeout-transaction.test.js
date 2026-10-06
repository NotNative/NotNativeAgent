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
function opsRequest(revision, operations, operationId = undefined) {
  return { installation_id: 'install_test', data_id: 'data_test', scope: 'user', expected_revision: revision,
    expected_resolution_revision: revision, operations,
    ...(operationId ? { operation_id: operationId } : {}) };
}
test('settings operations change the whole family under one CAS receipt and stamp updated_at', async t => {
  const f = await fixture(t), before = await f.service.read(read);
  assert.equal(before.enabled, false); assert.equal(before.token_present, true);
  assert.equal(before.authorized_user_ids.join(','), '123456789');
  const workspace = join(f.path, '..', 'workspace');
  const familyOps = [
    { op: 'set', field: 'enabled', value: true },
    { op: 'set', field: 'token_env', value: 'NNA_ALT_BOT_TOKEN' },
    { op: 'set', field: 'workspace_root', value: workspace },
    { op: 'set', field: 'polling_timeout_seconds', value: 40 },
    { op: 'authorize', user_id: 42 },
  ];
  const preview = await f.service.preview(manage, opsRequest(before.source_revision, familyOps));
  assert.equal(preview.valid, true);
  assert.equal(preview.enabled, true); assert.equal(preview.token_env, 'NNA_ALT_BOT_TOKEN');
  assert.ok(preview.workspace_root.endsWith('workspace')); assert.equal(preview.polling_timeout_seconds, 40);
  assert.deepEqual(preview.authorized_user_ids, ['123456789', '42']);
  // Preview validates without persisting; the source revision is unchanged after it.
  assert.equal((await f.service.read(read)).source_revision, before.source_revision);
  const token = 'replacement-telegram-bot-token-16';
  const saved = await f.service.save(manage, opsRequest(preview.source_revision, [
    ...familyOps, { op: 'set_token', token }, { op: 'revoke', user_id: '123456789' },
  ], 'family_ops'));
  assert.equal(saved.persistence, 'saved');
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.token, token); assert.equal(stored.token_env, 'NNA_ALT_BOT_TOKEN');
  assert.equal(stored.enabled, true); assert.equal(stored.polling_timeout_seconds, 40);
  assert.deepEqual(stored.authorized_user_ids, ['42']);
  assert.equal(typeof stored.updated_at, 'string');
  assert.equal(stored.future_private_key.secret, 'keep-me');
  const after = await f.service.read(read);
  assert.equal(after.token_present, true);
  assert.equal(JSON.stringify(after).includes(token), false);
  const cleared = await f.service.save(manage, opsRequest(after.source_revision, [
    { op: 'clear_token' }, { op: 'reset', field: 'token_env' }, { op: 'reset', field: 'workspace_root' },
    { op: 'reset', field: 'enabled' }, { op: 'reset', field: 'polling_timeout_seconds' },
  ], 'clear_all'));
  assert.equal(cleared.persistence, 'saved');
  const stripped = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stripped.token, null);
  assert.equal(stripped.token_env, 'NNA_TELEGRAM_BOT_TOKEN');
  assert.equal(stripped.workspace_root, null);
  assert.equal(stripped.enabled, false);
  assert.equal(stripped.polling_timeout_seconds, 25);
  assert.equal((await f.service.read(read)).token_present, false);
});
test('operation grammar rejects unknown fields, wrong types, oversized batches and token leakage in receipts', async t => {
  const f = await fixture(t), before = await f.service.read(read);
  for (const operations of [
    [{ op: 'explode' }],
    [{ op: 'set', field: 'enabled', value: 'yes' }],
    [{ op: 'set', field: 'token_env', value: 'lower-case' }],
    [{ op: 'set', field: 'workspace_root', value: 'relative/path' }],
    [{ op: 'set', field: 'polling_timeout_seconds', value: 4 }],
    [{ op: 'set', field: 'polling_timeout_seconds' }],
    [{ op: 'set', field: 'token', value: 'x' }],
    [{ op: 'set_token', token: 'too-short' }],
    [{ op: 'set_token', token: 'ok-token-with-twenty-chars-x', extra: true }],
    [{ op: 'authorize', user_id: '0' }],
    [{ op: 'revoke' }],
    [{ op: 'clear_token', field: 'unused' }],
  ]) {
    await assert.rejects(f.service.preview(manage, opsRequest(before.source_revision, operations)), { code: 'nnd_gateway_timeout_request_invalid' });
  }
  // Hostile field names must reject as grammar errors, never reach object
  // internals or produce receipts.
  for (const field of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
    await assert.rejects(f.service.preview(manage, opsRequest(before.source_revision,
      [{ op: 'set', field, value: 'hostile' }])), { code: 'nnd_gateway_timeout_request_invalid' });
  }
  await assert.rejects(f.service.preview(manage, opsRequest(before.source_revision,
    Array.from({ length: 17 }, () => ({ op: 'clear_token' })))));
  const body = { ...opsRequest(before.source_revision, [{ op: 'set', field: 'enabled', value: true }]),
    polling_timeout_seconds: 30 };
  await assert.rejects(f.service.preview(manage, body), { code: 'nnd_gateway_timeout_request_invalid' });
  const receipt = await f.service.save(manage, opsRequest(before.source_revision, [
    { op: 'set_token', token: 'completely-new-bot-token-17' }], 'payload_audit'));
  assert.equal(receipt.persistence, 'saved');
  assert.equal(JSON.stringify(receipt).includes('completely-new'), false);
  assert.equal((await f.service.operation(manage, 'payload_audit')).persistence, 'saved');
});
test('save on a missing or unrepaired source fails with the honest source code', async t => {
  const f = await fixture(t);
  const source = await import('node:fs/promises').then(nodeFs => nodeFs.mkdtemp(
    join(homedir(), 'nnd-gw-missing-')));
  t.after(() => import('node:fs/promises').then(nodeFs => nodeFs.rm(source, { recursive: true, force: true })));
  const missing = createNndGatewayTimeoutTransaction({ path: join(source, 'gateway.json'),
    installationId: 'install_test', dataId: 'data_test' });
  const principal = { subjectId: 'user', permissions: ['nnd.configuration.read', 'nnd.configuration.manage'] };
  await assert.rejects(missing.read(read), { code: 'nnd_gateway_timeout_source_missing' });
  await assert.rejects(missing.save(manage, { installation_id: 'install_test', data_id: 'data_test', scope: 'user',
    expected_revision: 'absent', expected_resolution_revision: 'absent', operation_id: 'missing_save',
    operations: [{ op: 'set', field: 'enabled', value: true }] }),
  { code: 'nnd_gateway_timeout_source_missing' });
  await assert.rejects(f.service.save(manage, { installation_id: 'install_test', data_id: 'data_test', scope: 'user',
    expected_revision: 'absent', expected_resolution_revision: 'absent', operation_id: 'absent_save',
    operations: [{ op: 'set', field: 'enabled', value: true }] }),
  { code: 'manifest_revision_conflict' });
});
test('flat first-party request remains a compatibility alias of one polling operation', async t => {
  const f = await fixture(t), before = await f.service.read(read);
  const receipt = await f.service.save(manage, request(before.source_revision, 'compat_shape'));
  assert.equal(receipt.persistence, 'saved');
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).polling_timeout_seconds, 30);
  assert.equal((await f.service.read(read)).polling_timeout_seconds, 30);
});
