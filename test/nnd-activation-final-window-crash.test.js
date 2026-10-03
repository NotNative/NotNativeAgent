// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireNndServiceLock } from '../src/nnd-service-lock.js';
import { withManifestLock } from '../src/persistence/manifest-transaction.js';
import { readNndActivationJournal } from '../src/nnd-activation-journal.js';
import { assertNoNndInstallTransaction } from '../src/nnd-install-storage.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('owner death inside final held-live window leaves exact journal and admission barrier for recovery',
  { skip: process.platform !== 'win32' }, async t => {
    const root = join(homedir(), `.nna-final-window-${randomUUID()}`);
    const operationId = randomUUID(), stageOperationId = randomUUID();
    const directory = join(root, 'runtime', 'nnd', 'install-slots', 'activations', operationId);
    await mkdir(root, { recursive: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    const child = fork(new URL('../scripts/test-support/nnd-final-window-worker.js', import.meta.url),
      [root, operationId, stageOperationId], { silent: true, execArgv: [] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let timer;
    const message = await Promise.race([
      once(child, 'message').then(([value]) => value),
      once(child, 'exit').then(([code]) => { throw new Error(`worker exited before final window: ${code}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('final window did not open')), 10000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(message, 'final-held');
    const exited = once(child, 'exit');
    child.kill(); await exited;
    const identity = { data_root: root, data_id: `data_${sha(root.toLowerCase())}`,
      installation_id: `nna_${sha('final-window-test-install')}`, operation_id: operationId };
    const lease = await acquireNndServiceLock({ dataRoot: root });
    try {
      await withManifestLock(join(root, 'config', 'nnd-package.json'), {}, async () => {
        const journal = await readNndActivationJournal(identity, directory);
        assert.deepEqual(journal.map(row => row.phase),
          ['prepared', 'trial_starting', 'trial_running', 'trial_healthy']);
        const marker = await readFile(join(root, 'runtime', 'nnd', 'installation-pending.json'));
        assert.equal(JSON.parse(marker).prepared_sha256, journal[0].receipt_sha256);
        await assert.rejects(assertNoNndInstallTransaction(identity), { code: 'nnd_install_transaction_pending' });
      });
    } finally { await lease.close(); }
  });
