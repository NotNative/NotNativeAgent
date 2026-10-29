// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireDesktopServiceLock } from '../src/desktop-service-lock.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';
import { appendDesktopActivationPhase, readDesktopActivationJournal } from '../src/desktop-activation-journal.js';
import { recordDesktopPrivateTicketUnderOwnership } from '../src/desktop-activation-ticket-receipt.js';
import { assertNoDesktopInstallTransaction, json } from '../src/desktop-install-storage.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const A = sha('external evidence A'), B = sha('external evidence B');
async function fixture(t) {
  const root = createScratchSync('nna-journal'), operation_id = randomUUID();
  const directory = join(root, 'runtime', 'desktop', 'install-slots', 'activations', operation_id);
  await mkdir(directory, { recursive: true }); await mkdir(join(root, 'config'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { data_root: root, data_id: `data_${sha(root.toLowerCase())}`,
    installation_id: `nna_${sha('test native install')}`, operation_id };
  return { root, directory, identity, registry: join(root, 'config', 'desktop-package.json') };
}
async function withOwnership(fixture, operation) {
  const lease = await acquireDesktopServiceLock({ dataRoot: fixture.root });
  try { return await withManifestLock(fixture.registry, {}, registry => operation(lease, registry)); }
  finally { await lease.close(); }
}
test('phase journal appends a bounded hash chain only under both native ownership locks',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    await withOwnership(f, async (lease, registry) => {
      const prepared = await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'prepared', A);
      assert.equal(prepared.sequence, 0); assert.equal(prepared.previous_sha256, null);
      const starting = await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'trial_starting', B);
      assert.equal(starting.previous_sha256, prepared.receipt_sha256);
      await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'registration_cas', A),
        { code: 'desktop_activation_journal_invalid' });
      await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'rollback_pending', A);
      await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'rollback_complete', B);
      await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'trial_running', A),
        { code: 'desktop_activation_journal_invalid' });
    });
    const read = await readDesktopActivationJournal(f.identity, f.directory);
    assert.deepEqual(read.map(item => item.phase), ['prepared', 'trial_starting', 'rollback_pending', 'rollback_complete']);
  });
test('private ticket receipt is unresolved and cannot skip proof or pending barrier',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    await withOwnership(f, async (lease, registry) => {
      for (const phase of ['prepared', 'trial_starting', 'trial_running', 'trial_healthy',
        'registration_cas', 'discovery_published']) {
        await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, phase, A);
      }
      const operationId = f.identity.operation_id;
      await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'completed', B),
        { code: 'desktop_activation_journal_invalid' });
      await assert.rejects(recordDesktopPrivateTicketUnderOwnership(f.identity, {}, lease, registry,
        { operationId, stageOperationId: randomUUID(), generation: randomUUID() }),
      { code: 'desktop_activation_health_invalid' });
      assert.equal((await readDesktopActivationJournal(f.identity, f.directory)).length, 6);
      await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'private_ticket_verified', B);
      await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'completed', B),
        { code: 'desktop_activation_journal_invalid' });
      await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'promoted_attach_verified', B);
      const journal = await readDesktopActivationJournal(f.identity, f.directory);
      assert.equal(journal[6].phase, 'private_ticket_verified');
      assert.equal(journal[7].phase, 'promoted_attach_verified');
      assert.equal(journal.some(row => row.phase === 'completed'), false);
      const marker = join(f.root, 'runtime', 'desktop', 'installation-pending.json');
      await writeFile(marker, json({ protocol: '3.0', purpose: 'desktop_activation', operation_id: operationId,
        installation_id: f.identity.installation_id, data_id: f.identity.data_id,
        prepared_sha256: journal[0].receipt_sha256 }));
      await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
    });
    // Reopening after the owner exits still reports an unresolved phase and
    // the durable pending marker continues to deny ordinary admission.
    assert.equal((await readDesktopActivationJournal(f.identity, f.directory)).at(-1).phase,
      'promoted_attach_verified');
    await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
    const last = join(f.directory, 'activation-06.json');
    const damaged = (await readFile(last, 'utf8')).replace(f.identity.operation_id, randomUUID());
    await writeFile(last, damaged);
    await assert.rejects(readDesktopActivationJournal(f.identity, f.directory),
      { code: 'desktop_activation_journal_invalid' });
    await assert.rejects(assertNoDesktopInstallTransaction(f.identity), { code: 'desktop_install_transaction_pending' });
  });
test('journal preserves malformed, missing and foreign receipts for recovery instead of skipping them', async t => {
  const f = await fixture(t);
  const first = join(f.directory, 'activation-00.json');
  await writeFile(first, Buffer.from('{"protocol":"2.0"}\n'));
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory), { code: 'desktop_activation_journal_invalid' });
  await rename(first, join(f.directory, 'activation-01.json'));
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory), { code: 'desktop_activation_journal_invalid' });
  await rename(join(f.directory, 'activation-01.json'), first);
  await writeFile(first, Buffer.alloc(2049));
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory), { code: 'desktop_activation_journal_invalid' });
  await writeFile(first, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory), { code: 'desktop_activation_journal_invalid' });
  await writeFile(join(f.directory, 'activation-hidden.json'), 'foreign');
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory), { code: 'desktop_activation_journal_invalid' });
  assert.equal((await readFile(first)).length, 2);
});
test('changed predecessor bytes break the next receipt hash chain', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await withOwnership(f, async (lease, registry) => {
    await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'prepared', A);
    await appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'trial_starting', B);
  });
  const first = join(f.directory, 'activation-00.json');
  const changed = (await readFile(first, 'utf8')).replace(A, B);
  await writeFile(first, changed);
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory), { code: 'desktop_activation_journal_invalid' });
});
test('identity-bound journal refuses a different operation or directory', async t => {
  const f = await fixture(t);
  await assert.rejects(readDesktopActivationJournal({ ...f.identity, operation_id: randomUUID() }, f.directory),
    { code: 'desktop_activation_journal_invalid' });
  await assert.rejects(readDesktopActivationJournal(f.identity, f.root), { code: 'desktop_activation_journal_invalid' });
});
test('renamed receipt cannot be mistaken for a fresh empty activation journal', async t => {
  const f = await fixture(t);
  const receipt = join(f.directory, 'activation-00.json');
  await writeFile(receipt, '{"protocol":"2.0"}\n');
  await rename(receipt, join(f.directory, 'operator-held-receipt.json'));
  await assert.rejects(readDesktopActivationJournal(f.identity, f.directory),
    { code: 'desktop_activation_journal_invalid' });
});
test('phase append refuses forged or expired ownership', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, {}, {}, 'prepared', A),
    { code: 'desktop_lock_lost' });
  const lease = await acquireDesktopServiceLock({ dataRoot: f.root });
  await lease.close();
  await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, lease, {}, 'prepared', A),
    { code: 'desktop_lock_lost' });
  assert.deepEqual(await readDesktopActivationJournal(f.identity, f.directory), []);
});
test('phase append rejects a genuine manifest lock for another target', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t);
  const lease = await acquireDesktopServiceLock({ dataRoot: f.root });
  try {
    await withManifestLock(join(f.root, 'config', 'other.json'), {}, async registry => {
      await assert.rejects(appendDesktopActivationPhase(f.identity, f.directory, lease, registry, 'prepared', A),
        { code: 'desktop_activation_journal_invalid' });
    });
  } finally { await lease.close(); }
  assert.deepEqual(await readDesktopActivationJournal(f.identity, f.directory), []);
});
