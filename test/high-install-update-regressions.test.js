// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { runUpdateCommand } from '../src/update-cli.js';
import { readUpdateState, checkForUpdate } from '../src/update-service.js';
import { WindowsAdministrator } from '../src/windows-admin.js';

test('unavailable update installation returns a failure exit status', async () => {
  assert.equal(await runUpdateCommand([], {}, { output: { write() {} }, installAvailableUpdate: async () => ({ installed: false, status: 'unavailable', current_version: '20260904-1', error_code: 'offline' }) }), 1);
});
test('update state validates timestamps, versions, hashes and unavailable state cannot install cached data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-update-boundary-')); const path = join(root, 'state.json');
  const valid = { format: 1, checked_at: new Date().toISOString(), status: 'ready', latest_version: '20260904-999', latest_sha: 'a'.repeat(40), latest_ref: 'main', latest_tag: null };
  for (const change of [{ checked_at: 'not a date' }, { latest_version: {} }, { latest_sha: '../../other' }, { status: 'unexpected' }]) {
    await writeFile(path, JSON.stringify({ ...valid, ...change })); assert.equal(await readUpdateState(path), null);
  }
  await writeFile(path, JSON.stringify(valid)); assert.equal((await readUpdateState(path)).status, 'ready');
  const result = await checkForUpdate({ statePath: path, currentVersion: '20260904-1', force: true, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.available, false);
});
test('silent update worker signals filesystem failure through its exit code', () => {
  const url = pathToFileURL(join(process.cwd(), 'src/update-check-worker.js')).href;
  const source = `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module'; fs.mkdir=async()=>{throw Object.assign(new Error('fixture'),{code:'EIO'})}; syncBuiltinESMExports(); await import(${JSON.stringify(url)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.status, 1); assert.equal(child.stdout, '');
});
test('administrator arguments fail before temp allocation or launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-admin-boundary-'));
  const admin = new WindowsAdministrator({ root }); admin.launch = async () => assert.fail('invalid arguments launched');
  for (const args of [undefined, {}, { timeout_ms: NaN }, { timeout_ms: 99 }, { timeout_ms: 3600001 }]) {
    await assert.rejects(admin.execute({ args }, new AbortController().signal), { code: 'elevation_request_invalid' });
  }
  assert.deepEqual(await readdir(root), []);
});
test('failed progress observer does not cancel a healthy administrator operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nna-admin-observer-')); await writeFile(join(directory, 'started'), 'started');
  const original = globalThis.setInterval; let tick; let child;
  globalThis.setInterval = (fn) => { tick = fn; return { fixture: true }; };
  try {
    const admin = new WindowsAdministrator({ output: async () => { throw new Error('observer'); }, spawn: () => { child = new EventEmitter(); child.kill = () => assert.fail('observer killed process'); return child; } });
    const pending = admin.launch({ directory, powershell: 'unused' }, new AbortController().signal, { args: { timeout_ms: 1000 } });
    await tick(); child.emit('close', 0); assert.equal(await pending, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await readdir(directory)).includes('cancel'), false);
  } finally { globalThis.setInterval = original; }
});
test('POSIX Playwright setup preserves the product version', async () => {
  const source = (await readFile('install.sh', 'utf8')).replaceAll('\r\n', '\n');
  const start = source.indexOf('install_managed_playwright() {'); const fn = source.slice(start, source.indexOf('\n}', start) + 2);
  const script = `${fn}\nset -eu\nversion=release-version\ndata_root=/fixture\nnode_path=node_stub\nfind_npm() { printf true; }\nmkdir() { :; }\nchmod() { :; }\nstep() { :; }\nok() { :; }\nwarn() { :; }\nnna_runtime() { printf '{}'; }\nnode_stub() { if [ "$1" = -e ]; then printf 150.0; fi; }\ninstall_managed_playwright\nprintf '%s' "$version"`;
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
  const child = spawnSync(shell, ['-c', script], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'release-version');
});
test('POSIX secret input restores terminal state on EOF', async () => {
  const source = (await readFile('install.sh', 'utf8')).replaceAll('\r\n', '\n');
  const start = source.indexOf('read_secret() {'); assert.ok(start >= 0);
  const fn = source.slice(start, source.indexOf('\n}', start) + 2);
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
  const script = `${fn}\nset -eu\nstty() { printf '%s\\n' "$*" >&2; if [ "$1" = -g ]; then printf saved-state; fi; }\nread_secret secret`;
  const child = spawnSync(shell, ['-c', script], { input: '', encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /-echo\nsaved-state/);
});
