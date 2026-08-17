// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { persistAtomicJson, persistAtomicJsonIfAbsent, quarantineMalformedJson } from '../src/persistence/atomic-json.js';

test('atomic JSON publications and quarantine sync their containing directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-atomic-json-directory-'));
  const calls = [];
  const syncDirectory = async (path) => calls.push(path);
  const first = join(root, 'config', 'first.json');
  const second = join(root, 'config', 'second.json');
  try {
    await persistAtomicJson(first, { value: 1 }, { syncDirectory });
    await persistAtomicJsonIfAbsent(second, { value: 2 }, { syncDirectory });
    await writeFile(first, '{broken', 'utf8');
    await assert.rejects(quarantineMalformedJson(first, 'fixture', 'fixture_invalid', {
      syncDirectory, timestamp: 1,
    }), { code: 'fixture_invalid' });
    assert.deepEqual(calls, [dirname(first), dirname(second), dirname(first)]);
    assert.deepEqual(JSON.parse(await readFile(second, 'utf8')), { value: 2 });
    assert.equal(await readFile(`${first}.corrupt-1`, 'utf8'), '{broken');
  } finally { await rm(root, { recursive: true, force: true }); }
});
