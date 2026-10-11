// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { runInstalledService } from './serve-installed.mjs';

test('the installed entry refuses any non-supervised launch and names the supervised contract', async () => {
  await assert.rejects(() => runInstalledService([]), /supervision: serve-installed\.mjs --supervised/u);
  await assert.rejects(() => runInstalledService(['--port', '57123']), /supervision: serve-installed\.mjs --supervised/u);
  await assert.rejects(() => runInstalledService(['--supervised', '--port', '57123']), /supervision/u);
});

test('the installed entry file fails closed with the same refusal', async t => {
  const entry = resolve('scripts/serve-installed.mjs');
  const refused = spawnSync(process.execPath, [entry, '--port', '57123'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /runs only under NNA supervision/u);
});
