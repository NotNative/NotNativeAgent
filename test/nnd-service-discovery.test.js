// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireNndServiceLock, withNndServiceLease } from '../src/nnd-service-lock.js';
import { ensurePrivateNndRuntimeDirectory } from '../src/nnd-service-private-storage.js';
import { createNndDiscoveryGeneration, createNndTrialDiscoveryGeneration, discardNndTrialDiscoveryGeneration,
  publishNndDiscoveryGeneration, readNndPrivateDiscoveryGeneration,
  readNndServiceDiscovery, removeNndDiscoveryPointer } from '../src/nnd-service-discovery.js';

const windows = { skip: process.platform !== 'win32' };
function ps(script, request) {
  const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $request=[Console]::In.ReadToEnd()|ConvertFrom-Json; " + script],
    { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192 });
  assert.equal(result.status, 0, 'Fixture ACL operation failed');
}
async function fixture(t) {
  const root = join(homedir(), `.nna-discovery-test-${randomUUID()}`);
  ps(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    [void][IO.Directory]::CreateDirectory($request.root,$acl)`, { root });
  const data = await realpath(root);
  const identity = { installation_id: 'nna_'+'a'.repeat(64), data_id: 'data_'+createHash('sha256').update(data.toLowerCase()).digest('hex'), data_root: data };
  const lease = await acquireNndServiceLock({ dataRoot: data });
  t.after(async () => {
    await lease.close();
    assert.equal(dirname(root), homedir());
    assert.match(root.slice(homedir().length), /^[\\/]\.nna-discovery-test-[a-f0-9-]+$/u);
    await rm(root, { recursive: true, force: true });
  });
  return { root, identity, lease, directory: join(root, 'runtime', 'nnd') };
}
const create = (f) => createNndDiscoveryGeneration(f.identity, f.lease, { endpoint: 'http://127.0.0.1:54321' });

test('discovery process identity does not require PowerShell on PATH', windows, async (t) => {
  const f = await fixture(t);
  const previous = process.env.PATH;
  process.env.PATH = join(f.root, 'no-executables');
  try {
    const record = await create(f);
    assert.equal(record.process_identity.pid, process.pid);
    assert.match(record.process_identity.start_id, /^\d{1,32}$/u);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
test('generation credentials remain private and pointer publication is explicit and generation-bound', windows, async (t) => {
  const f = await fixture(t);
  const record = await create(f);
  assert.equal(record.purpose, 'nnd_service_control');
  assert.equal(record.control_token.length, 43);
  assert.equal(await readNndServiceDiscovery(f.identity), null);
  await publishNndDiscoveryGeneration(f.identity, f.lease, record.instance_id, null);
  const discovered = await readNndServiceDiscovery(f.identity);
  assert.equal(discovered.control_token === record.control_token, true);
  const pointer = await readFile(join(f.directory, 'current.json'), 'utf8');
  assert.equal(pointer.includes(record.control_token), false);
  assert.equal(pointer.includes('control_token'), false);
  await removeNndDiscoveryPointer(f.identity, f.lease, record.instance_id);
  assert.equal(await readNndServiceDiscovery(f.identity), null);
});
test('fixed trial generation stays dark, preserves a third-party pointer, and cannot be replayed', windows, async (t) => {
  const f = await fixture(t);
  const previous = await create(f);
  await publishNndDiscoveryGeneration(f.identity, f.lease, previous.instance_id, null);
  const instanceId = randomUUID(), endpoint = 'http://127.0.0.1:54322';
  const trial = await createNndTrialDiscoveryGeneration(f.identity, f.lease, { endpoint, instanceId });
  assert.equal(trial.instance_id, instanceId);
  assert.equal(trial.endpoint, endpoint);
  assert.deepEqual(await readNndPrivateDiscoveryGeneration(f.identity, f.lease, instanceId), trial);
  assert.equal((await readNndServiceDiscovery(f.identity)).instance_id, previous.instance_id);
  await assert.rejects(createNndTrialDiscoveryGeneration(f.identity, f.lease, { endpoint, instanceId }));
  assert.equal((await readNndServiceDiscovery(f.identity)).instance_id, previous.instance_id);
  await assert.rejects(createNndTrialDiscoveryGeneration(f.identity, f.lease,
    { endpoint, instanceId: randomUUID().toUpperCase() }), { code: 'nnd_discovery_invalid' });
  await assert.rejects(discardNndTrialDiscoveryGeneration(f.identity, f.lease, previous.instance_id),
    { code: 'nnd_discovery_conflict' });
  assert.deepEqual(await discardNndTrialDiscoveryGeneration(f.identity, f.lease, instanceId), { discarded: true });
  await assert.rejects(readNndPrivateDiscoveryGeneration(f.identity, f.lease, instanceId), { code: 'nnd_discovery_invalid' });
  assert.equal((await readNndServiceDiscovery(f.identity)).instance_id, previous.instance_id);
  assert.equal((await createNndTrialDiscoveryGeneration(f.identity, f.lease, { endpoint, instanceId })).instance_id, instanceId);
});
test('forged, closed, and wrong-data leases cannot create credentials', windows, async (t) => {
  const f = await fixture(t);
  await assert.rejects(createNndDiscoveryGeneration(f.identity, { ...f.lease }, { endpoint: 'http://127.0.0.1:54321' }), { code: 'nnd_lock_lost' });
  await assert.rejects(createNndDiscoveryGeneration({ ...f.identity, data_id: 'data_'+'b'.repeat(64) }, f.lease,
    { endpoint: 'http://127.0.0.1:54321' }), { code: 'nnd_lock_lost' });
  await f.lease.close();
  await assert.rejects(create(f), { code: 'nnd_lock_lost' });
});
test('replacement requires exact previous generation and stale removal preserves newer owner', windows, async (t) => {
  const f = await fixture(t);
  const first = await create(f);
  const second = await create(f);
  assert.equal(first.control_token !== second.control_token, true);
  await publishNndDiscoveryGeneration(f.identity, f.lease, first.instance_id, null);
  await assert.rejects(publishNndDiscoveryGeneration(f.identity, f.lease, second.instance_id, null), { code: 'nnd_discovery_conflict' });
  await publishNndDiscoveryGeneration(f.identity, f.lease, second.instance_id, first.instance_id);
  await assert.rejects(access(join(f.directory, `generation-${first.instance_id}.json`)), { code: 'ENOENT' });
  await assert.rejects(removeNndDiscoveryPointer(f.identity, f.lease, first.instance_id), { code: 'nnd_discovery_conflict' });
  assert.equal((await readNndServiceDiscovery(f.identity)).instance_id, second.instance_id);
});
test('concurrent publication has exactly one winner and failed contenders cannot overwrite it', windows, async (t) => {
  const f = await fixture(t);
  const first = await create(f);
  const second = await create(f);
  const outcomes = await Promise.allSettled([first, second].map((record) =>
    publishNndDiscoveryGeneration(f.identity, f.lease, record.instance_id, null)));
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  const failure = outcomes.find((item) => item.status === 'rejected');
  assert.equal(['nnd_discovery_conflict', 'nnd_discovery_busy'].includes(failure.reason.code), true);
  const winner = outcomes[0].status === 'fulfilled' ? first : second;
  assert.equal((await readNndServiceDiscovery(f.identity)).instance_id, winner.instance_id);
});

test('shutdown removal waits for a competing discovery reader to release the gate', { ...windows, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const record = await create(f);
  await publishNndDiscoveryGeneration(f.identity, f.lease, record.instance_id, null);
  const holder = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
      $ErrorActionPreference='Stop'
      $path=[Console]::In.ReadLine()
      $gate=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      try { [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine() }
      finally { $gate.Dispose() }`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(holder, 'exit');
  t.after(async () => { if (holder.exitCode === null) { holder.kill(); await exited; } });
  const ready = once(holder.stdout, 'data');
  holder.stderr.on('data', () => {});
  holder.stdin.write(`${join(f.directory, 'publish.lock')}\n`);
  assert.equal(String((await ready)[0]).trim(), 'held');
  const release = setTimeout(() => holder.stdin.end('release\n'), 1200);
  try {
    await removeNndDiscoveryPointer(f.identity, f.lease, record.instance_id);
    assert.equal((await exited)[0], 0);
    assert.equal(await readNndServiceDiscovery(f.identity), null);
  } finally {
    clearTimeout(release);
    if (holder.exitCode === null) { holder.stdin.end('release\n'); await exited; }
  }
});
test('per-file foreign ACLs fail even inside a protected parent', windows, async (t) => {
  const f = await fixture(t);
  const record = await create(f);
  await publishNndDiscoveryGeneration(f.identity, f.lease, record.instance_id, null);
  const path = join(f.directory, `generation-${record.instance_id}.json`);
  ps(`$file=[IO.FileInfo]::new($request.path); $acl=$file.GetAccessControl()
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),
      [Security.AccessControl.FileSystemRights]::Read,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule); $file.SetAccessControl($acl)`, { path });
  await assert.rejects(readNndServiceDiscovery(f.identity), { code: 'nnd_private_acl_unsafe' });
});
test('corrupt pointer remains intact and malformed generation content cannot become a credential', windows, async (t) => {
  const f = await fixture(t);
  const record = await create(f);
  await publishNndDiscoveryGeneration(f.identity, f.lease, record.instance_id, null);
  const pointer = join(f.directory, 'current.json');
  const original = await readFile(pointer);
  await writeFile(pointer, '{');
  await assert.rejects(readNndServiceDiscovery(f.identity), { code: 'nnd_discovery_invalid' });
  await assert.rejects(removeNndDiscoveryPointer(f.identity, f.lease, record.instance_id), { code: 'nnd_discovery_invalid' });
  assert.equal(await readFile(pointer, 'utf8'), '{');
  await writeFile(pointer, original);
  await writeFile(join(f.directory, `generation-${record.instance_id}.json`), '{}');
  await assert.rejects(readNndServiceDiscovery(f.identity), { code: 'nnd_discovery_invalid' });
});
test('normal lease close drains in-flight publication before another owner can acquire', windows, async (t) => {
  const f = await fixture(t);
  const pending = create(f);
  const closing = f.lease.close();
  const record = await pending;
  await closing;
  assert.equal(typeof record.instance_id, 'string');
  const next = await acquireNndServiceLock({ dataRoot: f.root });
  await next.close();
});

test('timed-out operations keep singleton ownership until the underlying writer settles', windows, async (t) => {
  const f = await fixture(t);
  const releases = [];
  const pending = Array.from({ length: 8 }, () => withNndServiceLease(f.lease, f.identity.data_id,
    () => new Promise((resolve) => releases.push(resolve))));
  await assert.rejects(withNndServiceLease(f.lease, f.identity.data_id, async () => {}), { code: 'nnd_lock_operation_limit' });
  for (const resolve of releases) resolve();
  await Promise.all(pending);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finishWriter;
  const hung = withNndServiceLease(f.lease, f.identity.data_id, () => new Promise((resolve) => { finishWriter = resolve; }));
  await Promise.resolve();
  const denied = assert.rejects(hung, { code: 'nnd_lock_lost' });
  const closing = assert.rejects(f.lease.close(), { code: 'nnd_lock_lost' });
  t.mock.timers.tick(15000);
  await denied;
  await closing;
  t.mock.timers.reset();
  await assert.rejects(acquireNndServiceLock({ dataRoot: f.root }), { code: 'nnd_service_already_running' });
  finishWriter();
  await Promise.resolve();
  await f.lease.close();
  const next = await acquireNndServiceLock({ dataRoot: f.root });
  await next.close();
});
test('generation storage capacity fails closed and preserves orphan evidence', windows, async (t) => {
  const f = await fixture(t);
  await create(f);
  for (let index = 0; index < 63; index++) await writeFile(join(f.directory, `generation-orphan-${index}.json`), 'evidence');
  await assert.rejects(create(f), { code: 'nnd_discovery_capacity' });
  assert.equal(await readFile(join(f.directory, 'generation-orphan-0.json'), 'utf8'), 'evidence');
});

test('unreadable predecessor prevents replacement and preserves current discovery', windows, async (t) => {
  const f = await fixture(t);
  const first = await create(f);
  const second = await create(f);
  await publishNndDiscoveryGeneration(f.identity, f.lease, first.instance_id, null);
  const previous = join(f.directory, `generation-${first.instance_id}.json`);
  ps('[IO.File]::SetAttributes($request.path, [IO.FileAttributes]::ReadOnly)', { path: previous });
  try {
    await assert.rejects(publishNndDiscoveryGeneration(f.identity, f.lease, second.instance_id, first.instance_id),
      { code: 'nnd_private_storage_unavailable' });
    assert.equal(JSON.parse(await readFile(join(f.directory, 'current.json'), 'utf8')).instance_id, first.instance_id);
    await access(previous);
  } finally { ps('[IO.File]::SetAttributes($request.path, [IO.FileAttributes]::Normal)', { path: previous }); }
});
test('controller discovery accepts the shared canonical default-port endpoint', windows, async (t) => {
  const f = await fixture(t);
  const record = await createNndDiscoveryGeneration(f.identity, f.lease, { endpoint: 'http://127.0.0.1:80' });
  await publishNndDiscoveryGeneration(f.identity, f.lease, record.instance_id, null);
  assert.equal((await readNndServiceDiscovery(f.identity)).endpoint, 'http://127.0.0.1:80');
});
test('cancelled storage operations stop their helper and report no success', windows, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const pending = ensurePrivateNndRuntimeDirectory(f.root, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'nnd_lock_lost' });
});
