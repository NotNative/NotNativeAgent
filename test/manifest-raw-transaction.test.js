// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withManifestLock, transactLockedManifestBytes, readManifestSnapshot,
  readManifestOperation } from '../src/persistence/manifest-transaction.js';

async function fixture(t) {
  const parent = process.platform === 'win32' ? process.env.USERPROFILE : tmpdir();
  const root = await mkdtemp(join(parent, 'nna-manifest-raw-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'manifest.json');
}
const input = (path, expectedRevision, operationId, bytes) => ({ path, expectedRevision, operationId,
  payload: { action: 'restore-exact-bytes' }, bytes });

test('held raw CAS restores exact CRLF and malformed bytes without JSON serialization', async t => {
  const path = await fixture(t), current = Buffer.from('{"selected":true}\n');
  await writeFile(path, current);
  const prior = Buffer.from('{ "old": true }\r\n');
  await withManifestLock(path, {}, async lease => {
    const revision = (await readManifestSnapshot(path)).revision;
    const request = input(path, revision, 'raw-crlf', prior);
    const pending = transactLockedManifestBytes(lease, request);
    prior.fill(0); // The writer must retain its own copy across asynchronous work.
    request.expectedRevision = 'absent'; request.operationId = 'drifted'; request.path = path + '.other';
    const result = await pending;
    assert.equal(result.persistence, 'saved');
    assert.equal(result.beforeRevision, revision);
    assert.deepEqual(await readFile(path), Buffer.from('{ "old": true }\r\n'));
    assert.equal((await transactLockedManifestBytes(lease, input(path, revision, 'raw-crlf',
      Buffer.from('{ "old": true }\r\n')))).replayed, true);
    await assert.rejects(transactLockedManifestBytes(lease, input(path, revision, 'raw-crlf',
      Buffer.from('{"different":true}\n'))), { code: 'manifest_operation_conflict' });
  });
  const malformed = Buffer.from([0xff, 0xfe, 0x0d, 0x0a]);
  await withManifestLock(path, {}, async lease => {
    const revision = (await readManifestSnapshot(path)).revision;
    await transactLockedManifestBytes(lease, input(path, revision, 'raw-malformed', malformed));
  });
  assert.deepEqual(await readFile(path), malformed);
  assert.equal((await readManifestSnapshot(path)).rawManifest, null);
});

test('held raw CAS restores true absence and rejects stale or changed operation identity', async t => {
  const path = await fixture(t), current = Buffer.from('{"selected":true}\n');
  await writeFile(path, current);
  await withManifestLock(path, {}, async lease => {
    const revision = (await readManifestSnapshot(path)).revision;
    await assert.rejects(transactLockedManifestBytes(lease, input(path, 'absent', 'stale', null)),
      { code: 'manifest_revision_conflict' });
    assert.deepEqual(await readFile(path), current);
    const request = input(path, revision, 'raw-delete', null);
    const result = await transactLockedManifestBytes(lease, request);
    assert.equal(result.persistence, 'saved');
    assert.equal(result.persistedRevision, 'absent');
    assert.equal((await transactLockedManifestBytes(lease, request)).replayed, true);
    await assert.rejects(transactLockedManifestBytes(lease, input(path, revision, 'raw-delete', Buffer.alloc(0))),
      { code: 'manifest_operation_conflict' });
  });
  assert.equal((await readManifestSnapshot(path)).revision, 'absent');
  assert.equal((await readManifestOperation(path, 'raw-delete')).persistence, 'saved');
});

for (const phase of ['before', 'after', 'foreign']) {
  test(`process death around prepared raw deletion reconciles ${phase}`, { skip: process.platform !== 'win32' }, async t => {
    const path = await fixture(t);
    await writeFile(path, '{"selected":true}\n');
    const base = new URL('../src/persistence/', import.meta.url).href;
    const source = `import {withManifestLock,assertManifestLease} from ${JSON.stringify(base + 'manifest-lock.js')};
      import {readTargetSnapshot,digest,removeManifest} from ${JSON.stringify(base + 'manifest-files.js')};
      import {openManifestReceipts,prepareManifestReceipt} from ${JSON.stringify(base + 'manifest-receipts.js')};
      await withManifestLock(${JSON.stringify(path)},{},async lease=>{
        const target=assertManifestLease(lease),before=await readTargetSnapshot(target);
        const db=await openManifestReceipts(lease);
        prepareManifestReceipt(db,{id:'raw-death',payloadHash:digest('raw-death'),before:before.revision,
          after:'absent',backup:null,staged:null});
        if(${JSON.stringify(phase)}==='after')await removeManifest(target);
        process.stdout.write('prepared');setInterval(()=>{},1000);await new Promise(()=>{});
      });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    await once(child.stdout, 'data');
    const exited = once(child, 'exit'); child.kill(); await exited;
    if (phase === 'foreign') {
      await writeFile(path, '{"foreign":true}\n');
      await assert.rejects(readManifestOperation(path, 'raw-death'),
        { code: 'manifest_receipt_ambiguous', persistence: 'unknown' });
    } else {
      const receipt = await readManifestOperation(path, 'raw-death');
      assert.equal(receipt.persistence, phase === 'after' ? 'saved' : 'unpublished');
      assert.equal((await readManifestSnapshot(path)).revision === 'absent', phase === 'after');
    }
  });
}
