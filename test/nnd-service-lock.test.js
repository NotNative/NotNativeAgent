// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireNndServiceLock, withNndServiceLease } from '../src/nnd-service-lock.js';
import { ContractError } from '../src/ids.js';

const windows = { skip: process.platform !== 'win32', timeout: 15_000 };
const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nna-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'Data');
  await mkdir(dataRoot);
  return { root, dataRoot };
}

test('Windows singleton admits one concurrent owner and allows release then reacquisition', windows, async (t) => {
  const { dataRoot } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireNndServiceLock({ dataRoot })));
  const owners = results.filter((result) => result.status === 'fulfilled');
  t.after(async () => { for (const owner of owners) await owner.value.close(); });
  assert.equal(owners.length, 1);
  for (const result of results.filter((entry) => entry.status === 'rejected')) {
    assert.ok(result.reason instanceof ContractError);
    assert.equal(result.reason.code, 'nnd_service_already_running');
  }
  const lease = owners[0].value;
  assert.match(lease.pipeName, /^\\\\\.\\pipe\\nna-nnd-[a-f0-9]{64}$/u);
  assert.match(lease.dataId, /^data_[a-f0-9]{64}$/u);
  const closed = lease.close();
  assert.equal(lease.close(), closed);
  await closed;
  assert.equal(await lease.lost, null);
  assert.equal(lease.error, null);
  const replacement = await acquireNndServiceLock({ dataRoot });
  t.after(() => replacement.close());
  assert.equal(replacement.pipeName, lease.pipeName);
});

test('junction, case and installation changes cannot partition the same data root', windows, async (t) => {
  const { root, dataRoot } = await fixture(t);
  const alias = join(root, 'alias');
  await symlink(dataRoot, alias, 'junction');
  const lease = await acquireNndServiceLock({ dataRoot, installRoot: 'C:\\first', packageRoot: 'C:\\v1' });
  t.after(() => lease.close());
  for (const candidate of [alias, `${dataRoot}\\`, dataRoot.toUpperCase(), join(dataRoot, '..', 'Data')]) {
    await assert.rejects(acquireNndServiceLock({ dataRoot: candidate,
      installRoot: 'C:\\second', packageRoot: 'C:\\v2' }), { code: 'nnd_service_already_running' });
  }
});

test('another Windows process cannot acquire a held data root', windows, async (t) => {
  const { dataRoot } = await fixture(t);
  const lease = await acquireNndServiceLock({ dataRoot });
  t.after(() => lease.close());
  const moduleUrl = new URL('../src/nnd-service-lock.js', import.meta.url).href;
  const script = `const { acquireNndServiceLock } = await import(process.argv[1]);
    try { const lease = await acquireNndServiceLock({dataRoot: process.argv[2]});
      await lease.close(); console.log('unexpected_owner'); }
    catch (error) { console.log(error.code); }`;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script, moduleUrl, dataRoot],
    { windowsHide: true, timeout: 10_000, maxBuffer: 1024 });
  assert.equal(result.stdout.trim(), 'nnd_service_already_running');
  assert.equal(result.stderr, '');
});

test('lock connections close without a protocol and do not release ownership', windows, async (t) => {
  const { dataRoot } = await fixture(t);
  const lease = await acquireNndServiceLock({ dataRoot });
  t.after(() => lease.close());
  await new Promise((resolve, reject) => {
    const socket = connect(lease.pipeName);
    socket.setTimeout(2000, () => socket.destroy(new Error('Lock connection remained open.')));
    socket.on('error', reject);
    socket.on('close', resolve);
  });
  await assert.rejects(acquireNndServiceLock({ dataRoot }), { code: 'nnd_service_already_running' });
});

test('invalid, missing and non-directory roots fail closed', windows, async (t) => {
  const { root } = await fixture(t);
  const file = join(root, 'file');
  await writeFile(file, 'content');
  for (const dataRoot of [null, '', 'relative', 'C:\\' + 'x'.repeat(4096), `${root}\u0000`, join(root, 'missing'), file]) {
    await assert.rejects(acquireNndServiceLock({ dataRoot }), { code: 'nnd_lock_acquire_failed' });
  }
});

test('non-Windows hosts explicitly reject singleton acquisition', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(acquireNndServiceLock({ dataRoot: tmpdir() }), { code: 'nnd_service_platform_unsupported' });
});

test('bounded operation cancellation retains ownership until the actual writer settles', windows, async (t) => {
  const { dataRoot } = await fixture(t), lease = await acquireNndServiceLock({ dataRoot });
  let finish;
  const active = new Promise((resolve) => { finish = resolve; });
  t.after(async () => { finish(); await lease.close(); });
  await assert.rejects(withNndServiceLease(lease, lease.dataId, () => active, { timeoutMs: 10 }), { code: 'nnd_lock_lost' });
  const closing = lease.close();
  await assert.rejects(acquireNndServiceLock({ dataRoot }), { code: 'nnd_service_already_running' });
  finish(); await closing;
  const next = await acquireNndServiceLock({ dataRoot }); await next.close();
  await assert.rejects(withNndServiceLease(lease, lease.dataId, () => {}, { timeoutMs: 300001 }), { code: 'nnd_lock_operation_limit' });
});
