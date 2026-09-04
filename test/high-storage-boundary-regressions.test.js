// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedMcpCredentialReference, saveManagedMcpCredential } from '../src/mcp-credentials.js';
import { NnmGovernanceReceipts } from '../src/nnm-governance-receipts.js';
import { quarantineMalformedJson } from '../src/persistence/atomic-json.js';
import { renderTaskCheckpoint, writeTaskCheckpoint } from '../src/task-checkpoint.js';

test('managed credential IDs reject accidental coercion but retain supported display names', () => {
  for (const id of [null, undefined, {}, [], 3, '', 'x\ny']) assert.throws(() => managedMcpCredentialReference(id), { code: 'mcp_credentials_invalid' });
  assert.equal(typeof managedMcpCredentialReference('NotNative Memory'), 'string');
});

test('credential writes cannot exceed the loader bound or preserve invalid neighbors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-credential-bound-'));
  const paths = { mcpCredentials: join(root, 'credentials.json') };
  try {
    const credentials = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [managedMcpCredentialReference(`s${i}`), 'x'.repeat(16384)]));
    const previous = JSON.stringify({ format_version: 1, credentials }, null, 2);
    assert.ok(Buffer.byteLength(previous) < 1048576); await writeFile(paths.mcpCredentials, previous);
    const environment = {};
    await assert.rejects(saveManagedMcpCredential(paths, 'extra', 'x'.repeat(16384), environment), { code: 'mcp_credentials_full' });
    assert.equal(await readFile(paths.mcpCredentials, 'utf8'), previous); assert.deepEqual(environment, {});
    await writeFile(paths.mcpCredentials, JSON.stringify({ format_version: 1, credentials: { NOT_MANAGED: 'bad' } }));
    await assert.rejects(saveManagedMcpCredential(paths, 'valid', 'token', environment), { code: 'mcp_credentials_invalid' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid credential path cannot poison later queue attempts', { timeout: 1000 }, async () => {
  for (let i = 0; i < 2; i += 1) {
    const outcome = await Promise.race([saveManagedMcpCredential({}, 's', 'token', {}).then(() => 'saved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 50))]);
    assert.equal(outcome, 'rejected');
  }
});

test('receipt queries validate collection shape instead of iterating strings', async () => {
  const reader = new NnmGovernanceReceipts({ read: async () => '' });
  for (const value of ['turn-1', 5, {}, [null]]) {
    await assert.rejects(reader.matching({ workspaceRoot: '.', turnIds: value }), { code: 'nnm_receipt_query_invalid' });
    await assert.rejects(reader.matching({ workspaceRoot: '.', turnIds: [], sessionIds: value }), { code: 'nnm_receipt_query_invalid' });
  }
  assert.deepEqual(await reader.matching({ workspaceRoot: '.', turnIds: [] }), []);
});

test('default receipt reader rejects oversized on-disk journals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-receipt-size-'));
  try {
    const path = join(root, 'receipts.ndjson'); await writeFile(path, 'x'.repeat(4194305));
    await assert.rejects(new NnmGovernanceReceipts({ path }).matching({ workspaceRoot: '.', turnIds: ['t'] }), { code: 'nnm_receipts_too_large' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('same-timestamp quarantine preserves both corrupt samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-quarantine-'));
  try {
    const path = join(root, 'state.json');
    for (const content of ['first', 'second']) {
      await writeFile(path, content);
      await assert.rejects(quarantineMalformedJson(path, 'state', 'state_invalid', { timestamp: 1, syncDirectory: async () => {} }));
    }
    const names = (await readdir(root)).filter((name) => name.startsWith('state.json.corrupt-1'));
    assert.equal(names.length, 2); assert.deepEqual((await Promise.all(names.map((name) => readFile(join(root, name), 'utf8')))).sort(), ['first', 'second']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint writes do not reuse or remove an existing timestamp-named temporary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nna-checkpoint-temp-')); t.mock.method(Date, 'now', () => 1);
  try {
    const engine = { store: { path: join(root, 'session') }, sessionId: 's' };
    const previous = `${engine.store.path}.task-state.md.tmp-${process.pid}-1`;
    await writeFile(previous, 'owned by another write');
    await writeTaskCheckpoint(engine, {}); assert.equal(await readFile(previous, 'utf8'), 'owned by another write');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('checkpoint malformed tasks remain explicit unknowns instead of crashing', () => {
  for (const tasks of [[null, {}, 3], {}]) {
    const rendered = renderTaskCheckpoint({ work: { snapshot: () => ({ tasks }) } }, {});
    assert.equal(rendered.includes('undefined'), false);
  }
});
