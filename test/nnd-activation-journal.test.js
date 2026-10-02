// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireNndServiceLock } from '../src/nnd-service-lock.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';
import { appendNndActivationPhase, readNndActivationJournal } from '../src/nnd-activation-journal.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const A = sha('external evidence A'), B = sha('external evidence B');
async function fixture(t) {
  const root = join(homedir(), `.nna-journal-${randomUUID()}`), operation_id = randomUUID();
  const directory = join(root, 'runtime', 'nnd', 'install-slots', 'activations', operation_id);
  await mkdir(directory, { recursive: true }); await mkdir(join(root, 'config'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { data_root: root, data_id: `data_${sha(root.toLowerCase())}`,
    installation_id: `nna_${sha('test native install')}`, operation_id };
  return { root, directory, identity, registry: join(root, 'config', 'nnd-package.json') };
}
async function withOwnership(fixture, operation) {
  const lease = await acquireNndServiceLock({ dataRoot: fixture.root });
  try { return await withManifestLock(fixture.registry, {}, registry => operation(lease, registry)); }
  finally { await lease.close(); }
}
test('phase journal appends a bounded hash chain only under both native ownership locks',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    await withOwnership(f, async (lease, registry) => {
      const prepared = await appendNndActivationPhase(f.identity, f.directory, lease, registry, 'prepared', A);
      assert.equal(prepared.sequence, 0); assert.equal(prepared.previous_sha256, null);
      const starting = await appendNndActivationPhase(f.identity, f.directory, lease, registry, 'trial_starting', B);
      assert.equal(starting.previous_sha256, prepared.receipt_sha256);
      await assert.rejects(appendNndActivationPhase(f.identity, f.directory, lease, registry, 'registration_cas', A),
        { code: 'nnd_activation_journal_invalid' });
      await appendNndActivationPhase(f.identity, f.directory, lease, registry, 'rollback_pending', A);
      await appendNndActivationPhase(f.identity, f.directory, lease, registry, 'rollback_complete', B);
      await assert.rejects(appendNndActivationPhase(f.identity, f.directory, lease, registry, 'trial_running', A),
        { code: 'nnd_activation_journal_invalid' });
    });
    const read = await readNndActivationJournal(f.identity, f.directory);
    assert.deepEqual(read.map(item => item.phase), ['prepared', 'trial_starting', 'rollback_pending', 'rollback_complete']);
  });
test('journal preserves malformed, missing and foreign receipts for recovery instead of skipping them', async t => {
  const f = await fixture(t);
  const first = join(f.directory, 'activation-00.json');
  await writeFile(first, Buffer.from('{"protocol":"2.0"}\n'));
  await assert.rejects(readNndActivationJournal(f.identity, f.directory), { code: 'nnd_activation_journal_invalid' });
  await rename(first, join(f.directory, 'activation-01.json'));
  await assert.rejects(readNndActivationJournal(f.identity, f.directory), { code: 'nnd_activation_journal_invalid' });
  await rename(join(f.directory, 'activation-01.json'), first);
  await writeFile(first, Buffer.alloc(2049));
  await assert.rejects(readNndActivationJournal(f.identity, f.directory), { code: 'nnd_activation_journal_invalid' });
  await writeFile(first, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readNndActivationJournal(f.identity, f.directory), { code: 'nnd_activation_journal_invalid' });
  await writeFile(join(f.directory, 'activation-hidden.json'), 'foreign');
  await assert.rejects(readNndActivationJournal(f.identity, f.directory), { code: 'nnd_activation_journal_invalid' });
  assert.equal((await readFile(first)).length, 2);
});
test('changed predecessor bytes break the next receipt hash chain', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await withOwnership(f, async (lease, registry) => {
    await appendNndActivationPhase(f.identity, f.directory, lease, registry, 'prepared', A);
    await appendNndActivationPhase(f.identity, f.directory, lease, registry, 'trial_starting', B);
  });
  const first = join(f.directory, 'activation-00.json');
  const changed = (await readFile(first, 'utf8')).replace(A, B);
  await writeFile(first, changed);
  await assert.rejects(readNndActivationJournal(f.identity, f.directory), { code: 'nnd_activation_journal_invalid' });
});
test('identity-bound journal refuses a different operation or directory', async t => {
  const f = await fixture(t);
  await assert.rejects(readNndActivationJournal({ ...f.identity, operation_id: randomUUID() }, f.directory),
    { code: 'nnd_activation_journal_invalid' });
  await assert.rejects(readNndActivationJournal(f.identity, f.root), { code: 'nnd_activation_journal_invalid' });
});
test('renamed receipt cannot be mistaken for a fresh empty activation journal', async t => {
  const f = await fixture(t);
  const receipt = join(f.directory, 'activation-00.json');
  await writeFile(receipt, '{"protocol":"2.0"}\n');
  await rename(receipt, join(f.directory, 'operator-held-receipt.json'));
  await assert.rejects(readNndActivationJournal(f.identity, f.directory),
    { code: 'nnd_activation_journal_invalid' });
});
test('phase append refuses forged or expired ownership', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(appendNndActivationPhase(f.identity, f.directory, {}, {}, 'prepared', A),
    { code: 'nnd_lock_lost' });
  const lease = await acquireNndServiceLock({ dataRoot: f.root });
  await lease.close();
  await assert.rejects(appendNndActivationPhase(f.identity, f.directory, lease, {}, 'prepared', A),
    { code: 'nnd_lock_lost' });
  assert.deepEqual(await readNndActivationJournal(f.identity, f.directory), []);
});
test('phase append rejects a genuine manifest lock for another target', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const lease = await acquireNndServiceLock({ dataRoot: f.root });
  try {
    await withManifestLock(join(f.root, 'config', 'other.json'), {}, async registry => {
      await assert.rejects(appendNndActivationPhase(f.identity, f.directory, lease, registry, 'prepared', A),
        { code: 'nnd_activation_journal_invalid' });
    });
  } finally { await lease.close(); }
  assert.deepEqual(await readNndActivationJournal(f.identity, f.directory), []);
});
