// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMigrationActivity } from '../src/nnd-migration-activity.js';
import { digest } from '../src/nnd-migration-files.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-migration-activity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const directory = join(sessions, 'nnd-contexts.json.activity');
  await mkdir(directory, { recursive: true });
  const parent = { sessionId: 'session.foo', createdAt: 1 };
  const path = join(directory, `${Buffer.from(parent.sessionId).toString('hex')}.json`);
  return { paths: { root, sessions }, parent, path, signal: new AbortController().signal };
}
test('migration validates existing activity without rewriting any display bytes', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify({ version: 1, sessionId: f.parent.sessionId, createdAt: 1,
    records: [{ id: 'turn:1', sessionID: f.parent.sessionId, time: 1, kind: 'turn', status: 'completed', summary: 'Done' }] }));
  await writeFile(f.path, bytes);
  const evidence = [];
  await validateMigrationActivity(f.paths, [f.parent], evidence, f.signal);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].hash, digest(bytes));
  assert.deepEqual(await readFile(f.path), bytes);
});
test('invalid parent activity fails before migration staging and preserves evidence', async (t) => {
  const f = await fixture(t);
  for (const bytes of ['{truncated', JSON.stringify({ version: 1, sessionId: f.parent.sessionId, createdAt: 1,
    records: [{ id: 'turn:1', sessionID: 'other', time: 1, kind: 'turn', status: 'completed', summary: 'Done' }] })]) {
    await writeFile(f.path, bytes);
    await assert.rejects(validateMigrationActivity(f.paths, [f.parent], [], f.signal), { code: 'nnd_migration_invalid' });
    assert.equal(await readFile(f.path, 'utf8'), bytes);
  }
});
