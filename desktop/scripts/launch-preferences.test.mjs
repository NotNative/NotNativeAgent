// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLaunchPreferences, saveLaunchPreferences } from './launch-preferences.mjs';

test('launch preference persists, detects conflicts and preserves invalid files', t => {
  const root = mkdtempSync(join(tmpdir(), 'nna-launch-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config', 'desktop-launch.json');
  assert.deepEqual(readLaunchPreferences(file), { target: 'desktop', revision: 'absent' });
  const saved = saveLaunchPreferences(file, { revision: 'absent', target: 'browser' });
  assert.equal(saved.target, 'browser'); assert.match(saved.revision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(readLaunchPreferences(file), saved);
  assert.throws(() => saveLaunchPreferences(file, { revision: 'absent', target: 'desktop' }), /conflict/u);
  for (const target of ['edge', '', { url: 'https://example.com' }]) {
    assert.throws(() => saveLaunchPreferences(file, { revision: saved.revision, target }), /invalid/u);
  }
  const bytes = readFileSync(file);
  assert.throws(() => saveLaunchPreferences(file, { revision: saved.revision, target: 'desktop', extra: true }), /invalid/u);
  assert.deepEqual(readFileSync(file), bytes);
  writeFileSync(file, '{ broken');
  assert.throws(() => readLaunchPreferences(file));
  assert.throws(() => saveLaunchPreferences(file, { revision: saved.revision, target: 'desktop' }));
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
  writeFileSync(file, 'x'.repeat(4097)); assert.throws(() => readLaunchPreferences(file), /invalid/u);
});
