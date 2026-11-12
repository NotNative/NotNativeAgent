// SPDX-License-Identifier: Apache-2.0
/**
 * Ranking a session's opening tool surface from reviewer-ledger evidence.
 *
 * Why these are unit tests with injected IO: the ledger is real operator data, and
 * the rank must be provable against synthetic journals where the expected order is
 * known - including the legacy dotted names an older build wrote, which must not
 * displace anything since they name tools that no longer exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rankToolsFromLedger, sessionRankedToolNames, MAX_RANKED_SESSION_TOOLS } from '../src/tools/tool-rank.js';
import { planProviderToolNames } from '../src/tools/provider-surface-planner.js';

async function ledgerWith(lines) {
  const root = await mkdtemp(join(tmpdir(), 'nna-tool-rank-'));
  await writeFile(join(root, 'session_test.review.journal.ndjson'), lines.join('\n'), 'utf8');
  return root;
}

const call = (id, toolName) => [
  JSON.stringify({ type: 'proposal', payload: { requestId: id, toolName } }),
  JSON.stringify({ type: 'execution_terminal', payload: { requestId: id, terminal: { status: 'succeeded' } } }),
];

test('rank follows call counts, most-used first', async () => {
  const root = await ledgerWith([
    ...call('a1', 'fs_read'), ...call('a2', 'fs_read'), ...call('a3', 'fs_read'),
    ...call('b1', 'shell_run'),
  ]);
  const ranked = await rankToolsFromLedger({ root });
  assert.deepEqual(ranked.map((entry) => entry.name), ['fs_read', 'shell_run']);
  assert.equal(ranked[0].total, 3);
  assert.equal(ranked[0].succeeded, 3);
  await rm(root, { recursive: true, force: true });
});

test('a request that never settled counts as a call with a failure', async () => {
  // Why: an interrupted call is still evidence the model reached for the tool.
  const root = await ledgerWith([JSON.stringify({ type: 'proposal', payload: { requestId: 'x1', toolName: 'web_fetch' } })]);
  const ranked = await rankToolsFromLedger({ root });
  assert.equal(ranked[0].total, 1);
  assert.equal(ranked[0].failed, 1);
  await rm(root, { recursive: true, force: true });
});

test('an empty or missing ledger ranks nothing', async () => {
  assert.deepEqual(await rankToolsFromLedger({ root: join(tmpdir(), 'nna-rank-absent') }), []);
  const root = await mkdtemp(join(tmpdir(), 'nna-tool-rank-'));
  assert.deepEqual(await rankToolsFromLedger({ root }), []);
  await rm(root, { recursive: true, force: true });
});

test('session selection excludes the foundational baseline and caps the rest', async () => {
  const root = await ledgerWith([
    ...call('a1', 'fs_read'), ...call('a2', 'fs_read'),
    ...call('b1', 'fs_edit_text'), ...call('b2', 'fs_edit_text'),
    ...call('c1', 'web_fetch'),
  ]);
  const names = sessionRankedToolNames({ root, exclude: ['fs_read'] });
  assert.equal(names.includes('fs_read'), false, 'baseline tool must not be ranked for auto-load');
  assert.deepEqual(names, ['fs_edit_text', 'web_fetch']);
  assert.ok(names.length <= MAX_RANKED_SESSION_TOOLS);
  await rm(root, { recursive: true, force: true });
});

test('a name the registry does not install cannot take a surface slot', async () => {
  // Legacy dotted names from older builds are real evidence but dead spellings. The
  // planner filters by availability, so they cost nothing.
  const root = await ledgerWith([...call('a1', 'fs.read_text')]);
  const plan = planProviderToolNames({
    availableNames: ['fs_read_text', 'tool_search'], sessionRankedNames: ['fs.read_text'],
    encodedDefinition: () => 100,
  });
  assert.equal(plan.names.includes('fs.read_text'), false);
  assert.equal(plan.names.includes('tool_search'), true);
  await rm(root, { recursive: true, force: true });
});

test('ranked specialists load alongside the baseline and before leases', async () => {
  const plan = planProviderToolNames({
    availableNames: ['tool_search', 'fs_read', 'fs_edit_text', 'web_fetch', 'special_lease'],
    sessionRankedNames: ['fs_edit_text'], workflowLeaseNames: ['special_lease'],
    encodedDefinition: () => 100,
  });
  assert.deepEqual(plan.names, ['tool_search', 'fs_read', 'fs_edit_text', 'special_lease']);
  assert.equal(plan.composition, 'foundation_with_leases');
  assert.equal(plan.reasons.fs_edit_text, 'session_ranked');
});
