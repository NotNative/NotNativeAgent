// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, realpath, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ensureUserDataPaths, userDataPaths } from '../src/product.js';
import { resolveManifest } from '../src/config.js';
import { NND_CONFIGURATION_OPTIONS } from '../src/nnd-setup-config.js';
import { JournalStore } from '../src/store.js';
import { runNndMigration } from '../src/nnd-migration.js';
import { assertNoNndMigration, loadNndMigration } from '../src/nnd-migration-storage.js';
import { SessionLock } from '../src/persistence/session-lock.js';
import { runNndInstallGuard } from '../src/nnd-install-guard.js';
import { acquireNndServiceLock } from '../src/nnd-service-lock.js';
import { admitFreshNndServiceData } from '../src/nnd-service-admission.js';
import { createNndInstallMarker, clearNndInstallMarker } from '../src/nnd-install-marker.js';

const windows = { skip: process.platform !== 'win32', timeout: 60000 };
async function fixture(t, options = {}) {
  const root = join(homedir(), `.nna-migration-${randomUUID()}`);
  const created = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd();
    $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[Security.AccessControl.DirectorySecurity]::new();
    $acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
    [void][IO.Directory]::CreateDirectory($p,$acl)`], { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(created.status, 0, created.stderr);
  if (options.cleanup !== false) t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureUserDataPaths(userDataPaths({ environment: { NNA_HOME: join(root, 'data') } }));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const data_root = await realpath(paths.root);
  const identity = { installation_id: `nna_${'a'.repeat(64)}`, data_id: `data_${createHash('sha256').update(data_root.toLowerCase()).digest('hex')}`,
    data_root, node: process.execPath };
  const document = { workspace_root: workspace, provider: { id: 'primary', endpoint: 'http://127.0.0.1:1/v1', model: 'test', trust_zone: 'loopback' } };
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify(document));
  const config = resolveManifest(document, NND_CONFIGURATION_OPTIONS), id = 'legacy.session';
  const journal = new JournalStore(paths.sessions, id); await journal.open();
  await journal.append('session_created', { sessionId: id, workspaceRoot: workspace, executionManifest: config.executionManifest, mission: config.mission });
  await journal.close();
  const parent = { sessionId: id, subjectId: 'nnd-local-operator', workspaceIds: ['local'], title: 'Preserved', directory: workspace,
    createdAt: 1, updatedAt: 2, reviewMode: 'auto-review', reviewRevision: 7 };
  const catalog = join(paths.sessions, 'nnd-contexts.json'); await writeFile(catalog, JSON.stringify([parent]));
  const child = { version: 1, sessionId: 'child_one', parentId: id, subjectId: parent.subjectId, workspaceIds: ['local'],
    parentCreatedAt: 1, createdAt: 2, updatedAt: 3, directory: workspace, title: 'Child', configuredModel: null, transcript: [], activity: [] };
  await mkdir(`${catalog}.children`);
  const childPath = join(`${catalog}.children`, `${Buffer.from(child.sessionId).toString('hex')}.json`);
  await writeFile(childPath, JSON.stringify(child));
  return { root, paths, identity, parent, child, catalog, childPath, journalPath: journal.path };
}
const migrate = (f, checkpoint) => runNndMigration(f.identity, f.paths, 'migrate', { checkpoint });
const recover = (f) => runNndMigration(f.identity, f.paths, 'migration-recover');

test('migration rewrites only recognized scopes, preserving dotted session journals and review policy', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog), journal = await readFile(f.journalPath);
  const result = await migrate(f); assert.equal(result.migrated, true);
  const [parent] = JSON.parse(await readFile(f.catalog)); const child = JSON.parse(await readFile(f.childPath));
  assert.match(parent.workspaceIds[0], /^ws_[a-f0-9]{24}$/u);
  assert.deepEqual({ ...parent, workspaceIds: ['local'] }, f.parent);
  assert.deepEqual({ ...child, workspaceIds: ['local'] }, f.child);
  assert.deepEqual(await readFile(f.journalPath), journal);
  assert.deepEqual(await readFile(join(f.paths.root, 'runtime/nnd/migrations', result.transaction_id, '0.before')), original);
  await assertNoNndMigration(f.identity);
  const lease = await acquireNndServiceLock({ dataRoot: f.identity.data_root });
  try { assert.equal((await admitFreshNndServiceData(f.paths, f.identity, lease)).basis, 'legacy_catalog_migration'); }
  finally { await lease.close(); }
});

test('unfinished installer mutation excludes migration without changing catalog', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog);
  const marker = await createNndInstallMarker(f.identity);
  try { await assert.rejects(migrate(f), { code: 'nnd_install_guard_orphaned' }); }
  finally { await clearNndInstallMarker(marker); }
  assert.deepEqual(await readFile(f.catalog), original); await assertNoNndMigration(f.identity);
});

test('interrupted partial rewrite blocks admission until explicit exact-byte rollback', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog), child = await readFile(f.childPath);
  await assert.rejects(migrate(f, (phase) => { if (phase === 'replaced:0') throw new Error('simulated interruption'); }));
  await assert.rejects(assertNoNndMigration(f.identity), { code: 'nnd_migration_invalid' });
  await assert.rejects(runNndInstallGuard(f.identity), { code: 'nnd_migration_invalid' });
  const lease = await acquireNndServiceLock({ dataRoot: f.identity.data_root });
  try { await assert.rejects(admitFreshNndServiceData(f.paths, f.identity, lease), { code: 'nnd_migration_invalid' }); }
  finally { await lease.close(); }
  assert.equal((await recover(f)).state, 'rolled_back');
  assert.deepEqual(await readFile(f.catalog), original); assert.deepEqual(await readFile(f.childPath), child);
  await assertNoNndMigration(f.identity);
});

test('recovery refuses a transaction lock set that no longer matches exact catalog backup', windows, async (t) => {
  const f = await fixture(t);
  await assert.rejects(migrate(f, (phase) => { if (phase === 'prepared') throw new Error('simulated interruption'); }));
  const transaction = await loadNndMigration(f.identity);
  await writeFile(join(transaction.directory, 'transaction.json'), JSON.stringify({ ...transaction.record, sessions: [] }));
  await assert.rejects(recover(f), { code: 'nnd_migration_invalid' });
  await assert.rejects(assertNoNndMigration(f.identity), { code: 'nnd_migration_invalid' });
});

test('committed recovery refuses changed provenance and preserves pending evidence', windows, async (t) => {
  const f = await fixture(t);
  await assert.rejects(migrate(f, (phase) => { if (phase === 'committed') throw new Error('simulated interruption'); }));
  const original = await readFile(f.journalPath); await appendFile(f.journalPath, '\n');
  await assert.rejects(recover(f), { code: 'nnd_migration_invalid' });
  await assert.rejects(assertNoNndMigration(f.identity), { code: 'nnd_migration_invalid' });
  await writeFile(f.journalPath, original); assert.equal((await recover(f)).state, 'committed');
});

test('malformed session ownership and truncated journal refuse before transaction writes', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog);
  const lock = join(f.paths.sessions, `${f.parent.sessionId}.lock`); await writeFile(lock, '{unknown');
  await assert.rejects(migrate(f), { code: 'nnd_migration_locked' }); await rm(lock);
  const bytes = await readFile(f.journalPath); await writeFile(f.journalPath, bytes.subarray(0, bytes.length - 1));
  await assert.rejects(migrate(f), { code: 'nnd_migration_invalid' });
  assert.deepEqual(await readFile(f.catalog), original); await assertNoNndMigration(f.identity);
});

test('rollback refuses externally changed targets without discarding transaction', windows, async (t) => {
  const f = await fixture(t);
  await assert.rejects(migrate(f, (phase) => { if (phase === 'prepared') throw new Error('simulated interruption'); }));
  await writeFile(f.catalog, 'foreign-change');
  await assert.rejects(recover(f), { code: 'nnd_migration_invalid' });
  assert.equal(await readFile(f.catalog, 'utf8'), 'foreign-change');
  assert.ok((await loadNndMigration(f.identity)).record.id);
});

test('missing explicit workspace root cannot migrate under the process working directory', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog);
  const path = join(f.paths.config, 'manifest.json');
  const manifest = JSON.parse(await readFile(path)); delete manifest.workspace_root;
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(migrate(f), { code: 'nnd_migration_invalid' });
  assert.deepEqual(await readFile(f.catalog), original); await assertNoNndMigration(f.identity);
});

test('foreign parent and child workspace evidence cannot gain the configured workspace grant', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog), child = await readFile(f.childPath);
  const other = join(f.root, 'other-workspace'); await mkdir(other);
  await writeFile(f.catalog, JSON.stringify([{ ...f.parent, directory: other }]));
  await assert.rejects(migrate(f), { code: 'nnd_migration_invalid' });
  assert.equal(JSON.parse(await readFile(f.catalog))[0].directory, other);
  await writeFile(f.catalog, original);
  await writeFile(f.childPath, JSON.stringify({ ...f.child, directory: other }));
  await assert.rejects(migrate(f), { code: 'nnd_migration_invalid' });
  assert.equal(JSON.parse(await readFile(f.childPath)).directory, other);
  await writeFile(f.childPath, child); await assertNoNndMigration(f.identity);
});

test('custom workspace grants remain untouched and require explicit supported migration', windows, async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from(JSON.stringify([{ ...f.parent, workspaceIds: ['custom-workspace'] }]));
  await writeFile(f.catalog, bytes);
  await assert.rejects(migrate(f), { code: 'nnd_migration_invalid' });
  assert.deepEqual(await readFile(f.catalog), bytes); await assertNoNndMigration(f.identity);
});

test('a live TUI session owner blocks migration without disturbing its lock or journal', windows, async (t) => {
  const f = await fixture(t), original = await readFile(f.catalog), journal = await readFile(f.journalPath);
  const lock = new SessionLock(f.paths.sessions, f.parent.sessionId);
  await lock.acquire();
  const path = join(f.paths.sessions, `${f.parent.sessionId}.lock`), owned = await readFile(path);
  try {
    await assert.rejects(migrate(f), { code: 'nnd_migration_locked' });
    assert.deepEqual(await readFile(path), owned);
    assert.deepEqual(await readFile(f.catalog), original); assert.deepEqual(await readFile(f.journalPath), journal);
    await assertNoNndMigration(f.identity);
  } finally { await lock.release(); }
});

async function boundedCrashWait(pending, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Migration child deadline exceeded')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

test('actual migration process death retains pending evidence and recovers stale owned locks', windows, async (t) => {
  const f = await fixture(t, { cleanup: false });
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await boundedCrashWait(exited);
    // Invariant: fixture deletion requires the exact test-owned writer to have exited.
    await rm(f.root, { recursive: true, force: true });
  });
  const catalog = await readFile(f.catalog), snapshot = await readFile(f.childPath), journal = await readFile(f.journalPath);
  const moduleUrl = new URL('../src/nnd-migration.js', import.meta.url).href;
  const script = `const {runNndMigration}=await import(${JSON.stringify(moduleUrl)});
    process.once('message',async({identity,paths})=>{
      try {
        await runNndMigration(identity,paths,'migrate',{checkpoint:async(phase)=>{
          if(phase==='replaced:0') {process.send({phase});await new Promise(()=>{});}
        }});
        process.exit(0);
      } catch(error) {process.send({error:error.code??'migration_child_failed'});process.exit(1);}
    });`;
  child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  exited = once(child, 'exit');
  const checkpoint = once(child, 'message');
  child.send({ identity: f.identity, paths: f.paths });
  const [message] = await boundedCrashWait(Promise.race([checkpoint,
    exited.then(() => { throw new Error('Migration child exited before checkpoint'); })]));
  assert.deepEqual(message, { phase: 'replaced:0' });
  const lockPath = join(f.paths.sessions, `${f.parent.sessionId}.lock`);
  assert.equal(JSON.parse(await readFile(lockPath)).pid, child.pid);
  assert.notDeepEqual(await readFile(f.catalog), catalog);
  await assert.rejects(assertNoNndMigration(f.identity), { code: 'nnd_migration_invalid' });
  assert.equal(child.kill(), true); await boundedCrashWait(exited);
  assert.equal((await recover(f)).state, 'rolled_back');
  assert.deepEqual(await readFile(f.catalog), catalog); assert.deepEqual(await readFile(f.childPath), snapshot);
  assert.deepEqual(await readFile(f.journalPath), journal);
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' }); await assertNoNndMigration(f.identity);
});
