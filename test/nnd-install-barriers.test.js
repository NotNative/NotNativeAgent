// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNndIntegrationCommand } from '../src/integration-cli.js';
import { runNndServiceCommand } from '../src/nnd-service-cli.js';
import { ensurePrivateNndRuntimeDirectory } from '../src/nnd-service-private-storage.js';

test('stage CLI refuses missing and surplus arguments before reading an installation', async () => {
  for (const args of [
    ['stage-payload', 'missing'], ['stage-payload', 'missing', 'payload'],
    ['stage-payload', 'missing', 'payload', 'operation', 'extra'],
    ['stage-recover'], ['stage-recover', 'missing', 'operation', 'extra'],
    ['activation-preflight', 'missing', 'stage'],
    ['activation-preflight', 'missing', 'stage', 'activation', 'extra'],
    ['activation-preparation-recover', 'missing'],
    ['activation-preparation-recover', 'missing', 'activation', 'extra'],
  ]) await assert.rejects(runNndServiceCommand(args), { code: 'nnd_command_invalid' });
});

test('legacy serve preserves unfinished installer evidence and releases its failed-start lease', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-install-barriers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = (await ensurePrivateNndRuntimeDirectory(root)).path;
  let writes = 0;
  const options = { environment: {}, output: { write() { writes += 1; } } };
  for (const [name, code] of [
    ['installation-guard.json', 'nnd_install_guard_orphaned'],
    ['installation-pending.json', 'nnd_install_transaction_pending'],
    ['migration-pending.json', 'nnd_migration_invalid'],
  ]) {
    const path = join(runtime, name), evidence = Buffer.from('incomplete ownership evidence');
    await writeFile(path, evidence);
    // Invariant: repeated refusal proves the failed startup relinquished only its own lease.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(runNndIntegrationCommand(['serve'], { root }, options), { code });
      assert.deepEqual(await readFile(path), evidence);
    }
    await rm(path);
  }
  assert.equal(writes, 0);
});
