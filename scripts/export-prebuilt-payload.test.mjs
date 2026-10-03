// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, link, symlink, open, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { exportPrebuiltPayload } from './export-prebuilt-payload.mjs';
import { payloadPath, validateEntries, transferFile, createDestination, cleanupDestination, inventory, payloadTotal, PAYLOAD_LIMITS } from './payload-files.mjs';
import { verifyPrebuiltPayload, copyPrebuiltPayload } from './prebuilt-payload-validation.mjs';
import { parseElectronSmokeArguments } from './electron-native-attach-smoke.mjs';
import { payloadPlan, verifyElectronDependency } from './payload-export-plan.mjs';

const execute = promisify(execFile), windows = { skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 30000 };
const version = '20261002-1';
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-payload-')), root = join(base, 'source'), destination = join(base, 'payload');
  t.after(() => rm(base, { recursive: true, force: true })); await mkdir(root);
  const put = async (path, content) => { const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); };
  await put('package.json', JSON.stringify({ name: 'notnative-desktop', nnd_version: version, version: version.replace('-', '.0.'), type: 'module' }));
  await put('VERSION', version); await put('packages/web/dist/index.html', '<html>built</html>');
  await put('packages/electron/package.json', '{"type":"module"}');
  for (const name of ['main.mjs', 'preload.mjs', 'fixture.test.mjs']) await put(`packages/electron/${name}`, 'export const fixture = true;');
  await put('packages/electron/dist-server/server.mjs', 'export const fixture = true;');
  await put('packages/electron/dist-server/settings-registry.json', '{}');
  for (const name of ['tray-running.png', 'tray-stopped.png']) await put(`packages/electron/assets/${name}`, 'fixture');
  for (const name of ['package.json', 'lib/index.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
    'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/winpty-agent.exe', 'prebuilds/win32-x64/winpty.dll',
    'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe']) {
    await put(`packages/electron/dist-server/node_modules/node-pty/${name}`, 'fixture');
  }
  const runtime = 'packages/electron/node_modules/electron';
  await put(`${runtime}/package.json`, '{"name":"electron","version":"44.4.3"}'); await put(`${runtime}/dist/version`, '44.4.3');
  const pe = Buffer.alloc(128); pe.writeUInt16LE(0x5a4d, 0); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  await put(`${runtime}/dist/electron.exe`, pe); await put(`${runtime}/dist/locales/en-US.pak`, 'fixture');
  for (const name of ['resources/default_app.asar', 'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'resources.pak',
    'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll',
    'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'LICENSE', 'LICENSES.chromium.html']) await put(`${runtime}/dist/${name}`, 'fixture');
  for (const name of ['electron-build-stamp.mjs', 'serve-installed.mjs', 'serve-supervised.mjs', 'supervised-protocol.mjs',
    'installed-service-package.mjs', 'nnd-manifest-extensions.js', 'nnd-service-contract.js', 'nnd-contract-error.js']) {
    await put(`scripts/${name}`, await readFile(new URL(name, import.meta.url)));
  }
  const stamp = () => execute(process.execPath, [join(root, 'scripts/electron-build-stamp.mjs'), 'write'], { windowsHide: true, timeout: 10000 });
  await stamp(); return { root, base, destination, put, stamp };
}

test('payload paths and manifest counts enforce portable Windows namespace and byte bounds', () => {
  for (const value of ['', '/root', '../file', 'a/../b', 'a\\b', 'a:b', 'a//b', 'CON', 'nul.txt', 'COM1.exe', 'lpt².dat', 'a.', 'a ', 'a\u0000']) {
    assert.throws(() => payloadPath(value), /path-invalid/u);
  }
  for (const paths of [['a', 'A'], ['a', 'A/b'], ['a/b', 'A']]) assert.throws(() => validateEntries(paths.map((path) => ({ path }))), /duplicate/u);
  assert.throws(() => validateEntries(Array.from({ length: 20001 }, (_, index) => ({ path: `${index}` }))), /limit/u);
  assert.equal(payloadTotal(PAYLOAD_LIMITS.totalBytes - 1, 1), PAYLOAD_LIMITS.totalBytes);
  assert.throws(() => payloadTotal(PAYLOAD_LIMITS.totalBytes, 1), /limit/u);
  assert.throws(() => payloadTotal(0, PAYLOAD_LIMITS.fileBytes + 1), /limit/u);
});

test('fresh fixture export contains plain runtime files and deterministic complete hashes', windows, async (t) => {
  const f = await fixture(t), result = await exportPrebuiltPayload(f.destination, { sourceRoot: f.root });
  const bytes = await readFile(join(f.destination, 'NND_PAYLOAD.json')), manifest = JSON.parse(bytes);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(Object.keys(manifest), ['schema_version', 'version', 'platform', 'architecture', 'files']);
  assert.equal(manifest.files.some((entry) => entry.path.endsWith('.test.mjs')), false);
  assert.equal(manifest.files.some((entry) => entry.path.includes('nna-service-selection')), false);
  assert.equal(await readFile(join(f.destination, 'packages/electron/install-mode.txt'), 'utf8'), 'script');
  assert.ok(manifest.files.some((entry) => entry.path.endsWith('/electron.exe')));
  for (const entry of manifest.files) {
    const path = join(f.destination, entry.path), info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false); assert.equal(info.nlink, 1);
    assert.equal(info.size, entry.bytes); assert.deepEqual(await transferFile(path), { bytes: entry.bytes, sha256: entry.sha256 });
  }
  const second = join(f.base, 'second'); await exportPrebuiltPayload(second, { sourceRoot: f.root });
  assert.deepEqual(await readFile(join(second, 'NND_PAYLOAD.json')), bytes);
});

test('stale or unknown build identity refuses before creating destination', windows, async (t) => {
  const f = await fixture(t); await f.put('packages/electron/main.mjs', 'changed');
  await assert.rejects(exportPrebuiltPayload(f.destination, { sourceRoot: f.root }));
  await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  await f.stamp(); await f.put('packages/electron/build-stamp.json', '{"schema":999}');
  await assert.rejects(exportPrebuiltPayload(f.destination, { sourceRoot: f.root }));
});

test('destination ownership prevents source overlap and overwriting existing files', windows, async (t) => {
  const f = await fixture(t);
  await assert.rejects(createDestination(join(f.root, 'child'), [f.root]), /overlap/u);
  await assert.rejects(createDestination(f.root, [f.root]), /overlap/u);
  await assert.rejects(createDestination('relative', [f.root]), /absolute/u);
  await mkdir(f.destination); await writeFile(join(f.destination, 'keep'), 'preserve');
  await assert.rejects(exportPrebuiltPayload(f.destination, { sourceRoot: f.root }), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'preserve');
});

test('links, hardlinks, oversized and changed source files are rejected', windows, async (t) => {
  const f = await fixture(t), file = join(f.base, 'plain'); await writeFile(file, 'one');
  const expected = await transferFile(file); await writeFile(file, 'two');
  await assert.rejects(transferFile(file, null, expected), /source-changed/u);
  const hardlink = join(f.base, 'hardlink'); await link(file, hardlink);
  await assert.rejects(transferFile(hardlink), /source-type/u);
  const directoryLink = join(f.base, 'directory-link'); await symlink(f.root, directoryLink, 'junction');
  await assert.rejects(inventory(directoryLink), /source-link/u);
  const huge = join(f.base, 'huge'), handle = await open(huge, 'wx');
  try { await handle.truncate(PAYLOAD_LIMITS.fileBytes + 1); } finally { await handle.close(); }
  await assert.rejects(transferFile(huge), /size/u);
});

test('failed admission cleans only its newly owned destination', windows, async (t) => {
  const f = await fixture(t); await f.put('packages/electron/dist-server/server.mjs', ''); await f.stamp();
  await assert.rejects(exportPrebuiltPayload(f.destination, { sourceRoot: f.root }));
  await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  assert.ok((await readdir(f.root)).includes('VERSION'));
  const owned = await createDestination(f.destination, [f.root]); await cleanupDestination(owned);
  await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
});

test('output junctions are refused before any foreign descendant directory is created', windows, async (t) => {
  const f = await fixture(t), outside = join(f.base, 'outside'), output = join(f.base, 'output');
  await mkdir(outside); await mkdir(output); await writeFile(join(outside, 'sentinel'), 'keep');
  await symlink(outside, join(output, 'alias'), 'junction');
  await assert.rejects(transferFile(join(f.root, 'VERSION'), join(output, 'alias/new-child/file')), /target-link/u);
  assert.deepEqual(await readdir(outside), ['sentinel']);
});

test('incomplete Electron loader or runtime resources refuse before destination creation', windows, async (t) => {
  const f = await fixture(t), prefix = 'packages/electron/node_modules/electron/dist/';
  for (const name of ['resources/default_app.asar', 'icudtl.dat', 'v8_context_snapshot.bin']) {
    await rm(join(f.root, prefix, name));
    await assert.rejects(exportPrebuiltPayload(f.destination, { sourceRoot: f.root }), /runtime-incomplete/u);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' }); await f.put(prefix + name, 'fixture');
  }
});

test('prebuilt smoke parser preserves source mode and requires an explicit absolute payload', () => {
  const root = join(tmpdir(), 'native'), payload = join(tmpdir(), 'payload');
  assert.deepEqual(parseElectronSmokeArguments([root]), { nna: root, payloadRoot: null });
  assert.deepEqual(parseElectronSmokeArguments([root, '--native-configuration', '--native-configuration-write', '--native-tui-write']),
    { nna: root, payloadRoot: null, nativeConfiguration: true, nativeWrite: true, tuiWrite: true });
  assert.deepEqual(parseElectronSmokeArguments([root, '--native-configuration', '--native-configuration-write', '--native-routes-write']),
    { nna: root, payloadRoot: null, nativeConfiguration: true, nativeWrite: true, routeWrite: true });
  assert.deepEqual(parseElectronSmokeArguments([root, '--payload', payload]), { nna: root, payloadRoot: payload });
  assert.deepEqual(parseElectronSmokeArguments([root, '--payload', payload, '--native-slot']),
    { nna: root, payloadRoot: payload, nativeSlot: true });
  assert.deepEqual(parseElectronSmokeArguments([root, '--payload', payload, '--native-slot', '--native-configuration']),
    { nna: root, payloadRoot: payload, nativeSlot: true, nativeConfiguration: true });
  assert.deepEqual(parseElectronSmokeArguments([root, '--payload', payload, '--native-slot', '--native-configuration', '--native-configuration-write']),
    { nna: root, payloadRoot: payload, nativeSlot: true, nativeConfiguration: true, nativeWrite: true });
  assert.deepEqual(parseElectronSmokeArguments([root, '--payload', payload, '--native-slot', '--native-configuration', '--native-configuration-write', '--native-tui-write']),
    { nna: root, payloadRoot: payload, nativeSlot: true, nativeConfiguration: true, nativeWrite: true, tuiWrite: true });
  assert.deepEqual(parseElectronSmokeArguments([root, '--payload', payload, '--native-slot', '--native-configuration', '--native-configuration-write', '--native-routes-write']),
    { nna: root, payloadRoot: payload, nativeSlot: true, nativeConfiguration: true, nativeWrite: true, routeWrite: true });
  for (const args of [[], ['relative'], [root, '--payload'], [root, '--payload', 'relative'], [root, '--other', payload],
    [root, '--payload', payload, 'extra'], [root, '--native-slot'], [root, '--native-slot', payload],
    [root, '--native-slot', '--payload', payload], [root, '--payload', payload, '--native-slot', '--native-slot'],
    [root, '--payload', payload, '--native-configuration'],
    [root, '--payload', payload, '--native-slot', '--native-configuration-write'],
    [root, '--payload', payload, '--native-slot', '--native-configuration', '--other'],
    [root, '--payload', payload, '--native-slot', '--native-configuration', '--native-configuration-write', '--other']]) {
    assert.throws(() => parseElectronSmokeArguments(args), /usage/u);
  }
});

test('prebuilt fixture copy preserves every sealed file and admits no injected selection or harness', windows, async (t) => {
  const f = await fixture(t); await exportPrebuiltPayload(f.destination, { sourceRoot: f.root });
  const clone = join(f.base, 'copied'); await mkdir(clone);
  const original = await verifyPrebuiltPayload(f.destination), copied = await copyPrebuiltPayload(f.destination, clone);
  assert.equal(copied.sha256, original.sha256);
  assert.deepEqual(await readFile(join(clone, 'nna-integration/nnd-local/integration.json')),
    await readFile(join(f.destination, 'nna-integration/nnd-local/integration.json')));
  await assert.rejects(lstat(join(clone, 'nna-service-selection.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(clone, 'electron-smoke.mjs')), { code: 'ENOENT' });
  await writeFile(join(clone, 'packages/electron/main.mjs'), 'mutated');
  await assert.rejects(verifyPrebuiltPayload(clone), /source-changed/u);
});

test('prebuilt verification rejects malformed identity, unknown files and altered manifest entries', windows, async (t) => {
  const f = await fixture(t); await exportPrebuiltPayload(f.destination, { sourceRoot: f.root });
  const path = join(f.destination, 'NND_PAYLOAD.json'), bytes = await readFile(path), manifest = JSON.parse(bytes);
  for (const changed of [{ ...manifest, architecture: 'arm64' }, { ...manifest, platform: 'linux' },
    { ...manifest, version: '20260101-2' }, { ...manifest, files: [...manifest.files].reverse() },
    { ...manifest, files: [{ ...manifest.files[0], path: '../escape' }, ...manifest.files.slice(1)] }]) {
    await writeFile(path, JSON.stringify(changed)); await assert.rejects(verifyPrebuiltPayload(f.destination));
  }
  await writeFile(path, bytes); await writeFile(join(f.destination, 'unknown.txt'), 'extra');
  await assert.rejects(verifyPrebuiltPayload(f.destination), /inventory-mismatch/u);
});

test('pnpm hardlinked identity metadata is read-only and reverified while shipped hardlinks remain forbidden', windows, async (t) => {
  const f = await fixture(t), dependency = join(f.root, 'packages/electron/node_modules/electron');
  const metadata = join(dependency, 'package.json'); await link(metadata, join(f.base, 'pnpm-metadata'));
  assert.equal((await lstat(metadata)).nlink, 2);
  const result = await exportPrebuiltPayload(f.destination, { sourceRoot: f.root }); assert.ok(result.files > 0);
  await assert.rejects(lstat(join(f.destination, 'packages/electron/node_modules/electron/package.json')), { code: 'ENOENT' });
  const plan = await payloadPlan(f.root); await verifyElectronDependency(plan);
  await writeFile(metadata, '{"name":"electron","version":"changed"}');
  await assert.rejects(verifyElectronDependency(plan), /identity-changed/u);
  await writeFile(metadata, plan.runtimeMetadata);
  await link(join(dependency, 'dist/electron.exe'), join(f.base, 'linked-executable'));
  await assert.rejects(payloadPlan(f.root), /source-type/u);
});
