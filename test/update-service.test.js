// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runUpdateCommand } from '../src/update-cli.js';
import { checkForUpdate, compareVersions, parseVersion } from '../src/update-service.js';

test('NNA versions compare by date and numeric iteration', () => {
  assert.equal(compareVersions('20260809-10', '20260809-9') > 0, true);
  assert.equal(compareVersions('v20260810-1', '20260809-99') > 0, true);
  assert.deepEqual(parseVersion('v20260809-6'), { version: '20260809-6', date: 20260809, sequence: 6 });
  assert.throws(() => parseVersion('latest'), { code: 'update_version_invalid' });
});

test('update discovery reads VERSION from the immutable commit currently at main and reuses its cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-update-'));
  const statePath = join(root, 'update-state.json');
  let calls = 0;
  const sha = 'c'.repeat(40);
  const fetchImpl = async (url) => {
    calls += 1;
    if (url.endsWith('/commits/main')) return { ok: true, json: async () => ({ sha }) };
    assert.match(url, new RegExp(`/contents/VERSION\\?ref=${sha}$`, 'u'));
    return { ok: true, text: async () => '20260810-1\n' };
  };
  try {
    const first = await checkForUpdate({ statePath, currentVersion: '20260809-5', fetchImpl, force: true, now: 1_000_000 });
    assert.equal(first.available, true);
    assert.equal(first.latest_version, '20260810-1');
    assert.equal(first.latest_sha, sha);
    const cached = await checkForUpdate({ statePath, currentVersion: '20260809-5', fetchImpl, now: 1_000_100 });
    assert.equal(cached.cached, true);
    assert.equal(calls, 2);
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).latest_ref, 'main');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update discovery records network failure without throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-update-'));
  try {
    const result = await checkForUpdate({
      statePath: join(root, 'state.json'), currentVersion: '20260809-5', force: true,
      fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.available, false);
    assert.equal(result.error_code, 'update_check_unavailable');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update command distinguishes check-only from explicit installation', async () => {
  const writes = [];
  let installed = 0;
  const io = {
    output: { write: (value) => writes.push(value) },
    checkForUpdate: async () => ({ status: 'ready', available: true, current_version: '20260809-5', latest_version: '20260809-6' }),
    installAvailableUpdate: async () => { installed += 1; return { installed: true, current_version: '20260809-5', latest_version: '20260809-6' }; },
  };
  assert.equal(await runUpdateCommand(['--check'], { updateState: 'ignored' }, io), 0);
  assert.equal(installed, 0);
  assert.match(writes.pop(), /Update available/u);
  assert.equal(await runUpdateCommand([], { updateState: 'ignored' }, io), 0);
  assert.equal(installed, 1);
  assert.match(writes.pop(), /Updated NotNativeAgent/u);
});
