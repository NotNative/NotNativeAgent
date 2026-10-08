// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NndEngineHost } from '../src/nnd-engine-host.js';
import { childSnapshotPath } from '../src/nnd-child-snapshot.js';
import { primaryNndWorkspaceBinding } from '../src/nnd-workspace-binding.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nna-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace'), other = join(root, 'other'), catalog = join(root, 'catalog.json');
  await Promise.all([mkdir(workspace), mkdir(other)]);
  const id = `ws_${createHash('sha256').update(workspace).digest('hex').slice(0, 24)}`;
  const principal = { subjectId: 'nnd-local-operator', workspaceIds: [id] };
  const host = (override = {}) => new NndEngineHost({ catalogPath: catalog,
    primaryWorkspaceBinding: () => primaryNndWorkspaceBinding(workspace),
    createEngine: async () => ({ config: { workspaceRoot: workspace, executionManifest: null },
      async initialize() {}, async shutdown() {} }), ...override });
  return { root, workspace, other, catalog, principal, host };
}
function legacy(f) {
  return { sessionId: 'session_a', subjectId: f.principal.subjectId, workspaceIds: f.principal.workspaceIds,
    title: 'Existing session', directory: f.workspace, createdAt: Date.now(), updatedAt: Date.now() };
}

test('primary-only create persists one native binding and publishes its project ID', async t => {
  const f = await fixture(t), events = [];
  const host = f.host({ eventBus: { publishSession: event => events.push(event) } });
  await host.create('session_a', f.principal, { directory: f.workspace });
  const [record] = JSON.parse(await readFile(f.catalog, 'utf8'));
  assert.equal(record.workspaceBinding.id, f.principal.workspaceIds[0]);
  assert.equal(record.workspaceBinding.configured_root, f.workspace);
  assert.equal(record.workspaceIds.length, 1);
  assert.equal(host.get('session_a', f.principal).projectID, record.workspaceBinding.id);
  assert.equal(events.find(event => event.type === 'session.created')?.project, record.workspaceBinding.id);
  host.childSessions.register('child_a', 'session_a', f.principal,
    { config: { workspaceRoot: f.workspace }, transcript: [] });
  assert.equal(host.childSessions.get('child_a', f.principal).projectID, record.workspaceBinding.id);
  await host.create('session_b', { ...f.principal, workspaceIds: [...f.principal.workspaceIds, 'ws_second'] },
    { directory: f.workspace });
  assert.deepEqual(JSON.parse(await readFile(f.catalog, 'utf8'))[1].workspaceIds, [record.workspaceBinding.id]);
  await assert.rejects(host.create('session_c', f.principal, { directory: f.other }),
    { code: 'nnd_workspace_binding_invalid' });
  await host.shutdown();
});

test('workspace revocation guard refuses a new session until the native operation settles', async t => {
  const f = await fixture(t), host = f.host();
  await host.withWorkspaceRevocation(f.workspace, async () => {
    await assert.rejects(host.create('session_during_revoke', f.principal, { directory: f.workspace }),
      { code: 'nnd_workspace_in_use' });
  });
  await host.create('session_after_revoke', f.principal, { directory: f.workspace });
  await host.shutdown();
});

test('legacy one-root catalog migrates only exact directory and ID before engine initialization', async t => {
  const f = await fixture(t); await writeFile(f.catalog, JSON.stringify([legacy(f)]));
  let created = 0;
  const host = f.host({ createEngine: async () => { created++; return { config: { workspaceRoot: f.workspace },
    async initialize() {}, async shutdown() {} }; } });
  await host.initialize();
  assert.equal(created, 1);
  assert.equal(JSON.parse(await readFile(f.catalog, 'utf8'))[0].workspaceBinding.id, f.principal.workspaceIds[0]);
  await host.shutdown();
  for (const poisoned of [{ ...legacy(f), directory: f.other },
    { ...legacy(f), workspaceIds: ['ws_wrong'] }]) {
    await writeFile(f.catalog, JSON.stringify([poisoned])); created = 0;
    await assert.rejects(f.host({ createEngine: async () => { created++; throw new Error('must not construct'); } }).initialize(),
      { code: 'nnd_workspace_binding_invalid' });
    assert.equal(created, 0);
  }
  await writeFile(f.catalog, JSON.stringify([{ ...legacy(f), sessionId: 'session_good' },
    { ...legacy(f), sessionId: 'session_bad', directory: f.other }]));
  created = 0;
  await assert.rejects(f.host({ createEngine: async () => { created++; throw new Error('must not construct'); } }).initialize(),
    { code: 'nnd_workspace_binding_invalid' });
  assert.equal(created, 0, 'whole catalog must be preflighted before restoring the first engine');
});

test('poisoned persisted binding and replaced workspace fail before engine construction', async t => {
  const f = await fixture(t), first = f.host();
  await first.create('session_a', f.principal, { directory: f.workspace }); await first.shutdown();
  const original = JSON.parse(await readFile(f.catalog, 'utf8'));
  let created = 0;
  await writeFile(f.catalog, JSON.stringify([{ ...original[0], workspaceBinding: { ...original[0].workspaceBinding, inode: '0' } }]));
  await assert.rejects(f.host({ createEngine: async () => { created++; throw new Error('must not construct'); } }).initialize(),
    { code: 'nnd_workspace_binding_invalid' });
  assert.equal(created, 0);
  await writeFile(f.catalog, JSON.stringify(original));
  await rename(f.workspace, join(f.root, 'moved'));
  await mkdir(f.workspace);
  await assert.rejects(f.host({ createEngine: async () => { created++; throw new Error('must not construct'); } }).initialize(),
    { code: 'nnd_workspace_binding_invalid' });
  assert.equal(created, 0);
});

test('engine initialization cannot replay a different working directory under a primary binding', async t => {
  const f = await fixture(t); let stopped = 0;
  const host = f.host({ createEngine: async () => ({ config: { workspaceRoot: f.workspace },
    async initialize() { this.config = { workspaceRoot: f.other }; },
    async shutdown() { stopped++; } }) });
  await assert.rejects(host.create('session_a', f.principal, { directory: f.workspace }),
    { code: 'nnd_workspace_binding_invalid' });
  assert.equal(stopped, 1, 'failed engine must release resources');
  assert.deepEqual(host.list(f.principal), []);
  await assert.rejects(readFile(f.catalog), { code: 'ENOENT' });
});

test('a replacement primary directory blocks prompt admission while preserving the session catalog', async t => {
  const f = await fixture(t), host = f.host();
  await host.create('session_a', f.principal, { directory: f.workspace });
  const before = await readFile(f.catalog);
  await rename(f.workspace, join(f.root, 'moved'));
  await mkdir(f.workspace);
  await assert.rejects(host.assertWorkspaceBound('session_a', f.principal),
    { code: 'nnd_workspace_binding_invalid' });
  await assert.rejects(host.submit('session_a', { version: '1.0', type: 'submit',
    request_id: 'blocked_prompt', content: 'inspect this workspace' }, f.principal),
  { code: 'nnd_workspace_binding_invalid' });
  assert.deepEqual(await readFile(f.catalog), before);
  await host.shutdown();
});

test('restored child display cannot claim another directory under the primary project ID', async t => {
  const f = await fixture(t), first = f.host();
  await first.create('session_a', f.principal, { directory: f.workspace }); await first.shutdown();
  const parent = JSON.parse(await readFile(f.catalog, 'utf8'))[0];
  const path = childSnapshotPath(f.catalog, 'child_a');
  await mkdir(`${f.catalog}.children`);
  await writeFile(path, JSON.stringify({ version: 1, sessionId: 'child_a', parentId: 'session_a',
    parentCreatedAt: parent.createdAt, subjectId: f.principal.subjectId,
    workspaceIds: f.principal.workspaceIds, directory: f.other, title: 'Child', configuredModel: null,
    createdAt: parent.createdAt, updatedAt: parent.createdAt, transcript: [] }));
  await assert.rejects(f.host().initialize(), { code: 'nnd_child_snapshot_invalid' });
});
