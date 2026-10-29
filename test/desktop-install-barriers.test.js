// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { createScratchSync } from './scratch.js';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runDesktopIntegrationCommand } from '../src/integration-cli.js';
import { runDesktopServiceCommand } from '../src/desktop-service-cli.js';
import { ensurePrivateDesktopRuntimeDirectory } from '../src/desktop-service-private-storage.js';

test('stage CLI refuses missing and surplus arguments before reading an installation', async () => {
  for (const args of [
    ['stage-payload', 'missing'], ['stage-payload', 'missing', 'payload'],
    ['stage-payload', 'missing', 'payload', 'operation', 'extra'],
    ['stage-recover'], ['stage-recover', 'missing', 'operation', 'extra'],
    ['activation-preflight', 'missing', 'stage'],
    ['activation-preflight', 'missing', 'stage', 'activation', 'extra'],
    ['activate-slot', 'missing', 'stage'],
    ['activate-slot', 'missing', 'stage', 'activation', 'extra'],
    ['activation-preparation-recover', 'missing'],
    ['activation-preparation-recover', 'missing', 'activation', 'extra'],
  ]) await assert.rejects(runDesktopServiceCommand(args), { code: 'desktop_command_invalid' });
});

test('legacy serve refuses unfinished installer evidence on every platform', async t => {
  const root = createScratchSync('nna-install-barriers-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = process.platform === 'win32' ? (await ensurePrivateDesktopRuntimeDirectory(root)).path
    : join(root, 'runtime', 'desktop');
  if (process.platform !== 'win32') await mkdir(runtime, { recursive: true });
  let writes = 0;
  const options = { environment: {}, output: { write() { writes += 1; } } };
  for (const [name, code] of [
    ['installation-guard.json', 'desktop_install_guard_orphaned'],
    ['installation-pending.json', 'desktop_install_transaction_pending'],
    ['migration-pending.json', 'desktop_migration_invalid'],
  ]) {
    const path = join(runtime, name), evidence = Buffer.from('incomplete ownership evidence');
    await writeFile(path, evidence);
    // Repeated refusal preserves the evidence; on Windows it also proves the failed lease was released.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(runDesktopIntegrationCommand(['serve'], { root }, options), { code });
      assert.deepEqual(await readFile(path), evidence);
    }
    await rm(path);
  }
  assert.equal(writes, 0);
});
