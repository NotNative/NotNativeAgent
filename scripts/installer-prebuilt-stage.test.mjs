// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '20261003-22';
const fakeCli = `const { createHash } = require('node:crypto');
const { realpathSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const hash = value => createHash('sha256').update(realpathSync(value).toLowerCase()).digest('hex');
const root = process.argv[5], action = process.argv[4];
if (action === 'capabilities') {
  process.stdout.write(JSON.stringify({ protocol: '1.0', installation_id: 'nna_' + hash(root),
    data_id: 'data_' + hash(process.env.NNA_HOME), native_version: '${version}',
    capabilities: ['service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard'],
    commands: ['start', 'status', 'stop', 'attach', 'install-guard'] }));
} else if (action === 'stage-payload') {
  const payload = process.argv[6], operation = process.argv[7];
  const bytes = readFileSync(join(payload, 'NND_PAYLOAD.json'));
  const manifest = JSON.parse(bytes);
  for (const item of manifest.files) {
    const content = readFileSync(join(payload, item.path));
    if (sha256(content) !== item.sha256 || content.length !== item.bytes) process.exit(5);
  }
  writeFileSync(process.env.NND_TEST_STAGE_MARKER, operation);
  const result = { state: 'slot_ready', operation_id: operation, version: manifest.version,
    payload_sha256: sha256(bytes), slot: join(root, 'private-slot'), replay_window: 'last_16_terminal_operations' };
  if (process.env.NND_TEST_STAGE_MODE === 'wrong-response') result.payload_sha256 = '0'.repeat(64);
  process.stdout.write(JSON.stringify(result));
} else process.exit(6);
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-prebuilt-installer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const payload = join(base, 'payload'), target = join(base, 'NND existing');
  await mkdir(payload); await mkdir(target); await writeFile(join(target, 'keep.txt'), 'unchanged');
  const files = { 'package.json': JSON.stringify({ name: 'notnative-desktop', type: 'module',
    nnd_version: '20261003-12', version: '20261003.0.12' }), 'VERSION': '20261003-12\n',
  'packages/web/dist/index.html': '<html>fixture</html>' };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(payload, path, '..'), { recursive: true }); await writeFile(join(payload, path), bytes);
  }
  const manifest = JSON.stringify({ schema_version: '1.0', version: '20261003-12', platform: 'win32',
    architecture: 'x64', files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) })) });
  await writeFile(join(payload, 'NND_PAYLOAD.json'), manifest);
  const native = join(base, 'NNA selected'), data = join(base, 'NNA data');
  await mkdir(join(native, 'installed', 'src'), { recursive: true }); await mkdir(data);
  const cli = join(native, 'installed', 'src', 'cli.js'); await writeFile(cli, fakeCli);
  await writeFile(join(native, 'install.json'), JSON.stringify({ product: 'NotNativeAgent', version,
    node: process.execPath, install_root: native, data_root: data }));
  return { base, payload, target, native, marker: join(base, 'stage-marker'), digest: sha(manifest) };
}

function stage(f, digest = f.digest, mode = '') {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', resolve('install.ps1'),
    '-StagePrebuiltPayload', '-PrebuiltPayloadRoot', f.payload, '-PrebuiltManifestSha256', digest,
    '-NnaInstallRoot', f.native, '-InstallDir', f.target], {
    encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, Path: '', NND_TEST_STAGE_MARKER: f.marker, NND_TEST_STAGE_MODE: mode },
  });
}

test('prebuilt staging uses selected NNA without PATH and preserves the live NND target',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const success = stage(f);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /activation remains pending/u);
    assert.match(success.stdout, /active NND package and shortcuts were not changed/u);
    assert.match(await readFile(f.marker, 'utf8'), /^[a-f0-9-]{36}$/u);
    assert.deepEqual(await readdir(f.target), ['keep.txt']);
    assert.equal(await readFile(join(f.target, 'keep.txt'), 'utf8'), 'unchanged');
  });

test('wrong trusted digest rejects before native stage and malformed native outcome stays unresolved',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const bad = stage(f, '0'.repeat(64));
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /SHA-256 does not match/u);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    const unresolved = stage(f, f.digest, 'wrong-response');
    assert.notEqual(unresolved.status, 0);
    assert.match(unresolved.stderr, /stage-recover/u);
    assert.match(await readFile(f.marker, 'utf8'), /^[a-f0-9-]{36}$/u);
    assert.deepEqual(await readdir(f.target), ['keep.txt']);
  });

test('wrong trusted digest rejects before attempting a missing NNA dependency install',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const missingNative = join(f.base, 'NNA absent');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', resolve('install.ps1'),
      '-StagePrebuiltPayload', '-PrebuiltPayloadRoot', f.payload,
      '-PrebuiltManifestSha256', '0'.repeat(64), '-NnaInstallRoot', missingNative,
      '-NnaSourceRoot', join(f.base, 'missing source'), '-InstallNnaIfMissing', '-InstallDir', f.target], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...process.env, Path: '', NND_TEST_STAGE_MARKER: f.marker },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 does not match/u);
    assert.doesNotMatch(result.stderr, /local NNA installer was found/u);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.target), ['keep.txt']);
  });

test('a selected NNA identity change blocks staging before the native command',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    await writeFile(join(f.target, 'nna-service-selection.json'), JSON.stringify({ schema_version: '1.0',
      nna_install_root: f.native, installation_id: 'nna_' + '0'.repeat(64), data_id: 'data_' + '0'.repeat(64) }));
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', resolve('install.ps1'),
      '-StagePrebuiltPayload', '-PrebuiltPayloadRoot', f.payload,
      '-PrebuiltManifestSha256', f.digest, '-InstallDir', f.target], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...process.env, Path: '', NND_TEST_STAGE_MARKER: f.marker },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /selection identity changed/u);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    assert.deepEqual((await readdir(f.target)).sort(), ['keep.txt', 'nna-service-selection.json']);
  });

test('payload file tamper fails native admission and overlapping target is refused before staging',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const overlap = { ...f, target: f.payload };
    const refused = stage(overlap);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /payload and NND installation target must be separate/u);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    await writeFile(join(f.payload, 'packages/web/dist/index.html'), '<html>tampered</html>');
    const invalid = stage(f);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /stage-recover/u);
    await assert.rejects(readFile(f.marker), { code: 'ENOENT' });
    assert.deepEqual(await readdir(f.target), ['keep.txt']);
  });
