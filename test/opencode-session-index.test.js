// SPDX-License-Identifier: Apache-2.0
/**
 * The durable session index: one identity per session, renamed in place.
 *
 * Why dedicated tests: four surface defects traced to this file in one session -
 * a rename that stayed in memory, duplicate appends at boot restore, and the reads
 * that masked both. The index is what a restart lists from, so its write behaviour
 * is the persistence contract, not an implementation detail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendSessionIndex, readSessionIndex, updateSessionIndex, removeSessionIndex, discoverUnindexedSessions, tombstoneJournalName } from '../src/opencode/session-index.js';

const identity = (ocId, title = 'New session') => ({ ocId, sessionId: `session_${ocId}`, title, directory: 'D:\\x', createdAt: 1 });

test('a re-attach updates the existing identity instead of appending a duplicate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-index-'));
  await appendSessionIndex(root, identity('ses_a'));
  await appendSessionIndex(root, identity('ses_b'));
  // Boot restore re-attaches through the creation path: same ocId, fresh write.
  await appendSessionIndex(root, identity('ses_a'));
  const records = await readSessionIndex(root);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.ocId).sort(), ['ses_a', 'ses_b']);
  const raw = await readFile(join(root, 'opencode-sessions.ndjson'), 'utf8');
  assert.equal(raw.trim().split('\n').length, 2, 'the file holds one line per session');
  await rm(root, { recursive: true, force: true });
});

test('a rename is written back to the durable identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-index-'));
  await appendSessionIndex(root, identity('ses_a', 'New session'));
  await updateSessionIndex(root, 'ses_a', { title: 'bentonville weather' });
  const records = await readSessionIndex(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'bentonville weather');
  // The other fields survive the patch.
  assert.equal(records[0].directory, 'D:\\x');
  await rm(root, { recursive: true, force: true });
});

test('a rename for an unknown identity writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-index-'));
  await appendSessionIndex(root, identity('ses_a'));
  await updateSessionIndex(root, 'ses_absent', { title: 'ghost' });
  const records = await readSessionIndex(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'New session');
  await rm(root, { recursive: true, force: true });
});

test('a removal takes the whole identity with it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-index-'));
  await appendSessionIndex(root, identity('ses_a'));
  await appendSessionIndex(root, identity('ses_b'));
  await removeSessionIndex(root, 'ses_a');
  const records = await readSessionIndex(root);
  assert.deepEqual(records.map((record) => record.ocId), ['ses_b']);
  await rm(root, { recursive: true, force: true });
});

test('a tombstoned journal is never rediscovered as a live session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-index-'));
  // A deleted session's journal: index entry removed, journal tombstoned.
  await writeFile(join(root, `${tombstoneJournalName('session_dead')}`), '{}\n', 'utf8');
  // An orphaned live journal with no index entry: discovery must adopt it.
  await writeFile(join(root, 'session_live.journal.ndjson'),
    `${JSON.stringify({ type: 'session_created', payload: { workspaceRoot: 'D:\\x' } })}\n`, 'utf8');
  const discovered = await discoverUnindexedSessions(root, []);
  assert.deepEqual(discovered.map((entry) => entry.sessionId), ['session_live']);
  await rm(root, { recursive: true, force: true });
});
