// SPDX-License-Identifier: Apache-2.0
import { readdir, realpath, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inventory, noLinks, transferFile, validateEntries, within, payloadTotal, PAYLOAD_LIMITS } from './payload-files.mjs';

const execute = promisify(execFile);
const SCRIPTS = ['serve-installed.mjs', 'serve-supervised.mjs', 'supervised-protocol.mjs',
  'installed-service-package.mjs', 'nnd-manifest-extensions.js', 'nnd-service-contract.js', 'nnd-contract-error.js'];
async function metadata(path, readOnlyDependency = false) {
  await noLinks(path);
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || (!readOnlyDependency && info.nlink !== 1) || info.size > 65536) throw new Error('payload-metadata-invalid');
    const bytes = Buffer.alloc(65537); let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, null);
      if (!result.bytesRead) break; count += result.bytesRead;
    }
    const after = await handle.stat(), current = await lstat(path);
    if (count > 65536 || count !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs
      || info.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.ino !== info.ino || current.dev !== info.dev) throw new Error('payload-metadata-invalid');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
  } finally { await handle.close(); }
}
export async function verifyBuildStamp(root) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/iu.test(key)));
  await execute(process.execPath, [join(root, 'scripts/electron-build-stamp.mjs'), 'check'], {
    cwd: root, windowsHide: true, shell: false, timeout: 60000, maxBuffer: 16384, env: environment,
  });
  return metadata(join(root, 'packages/electron/build-stamp.json'));
}
export async function payloadPlan(rootInput) {
  const root = await noLinks(rootInput);
  const packageInfo = JSON.parse(await metadata(join(root, 'package.json')));
  const version = (await metadata(join(root, 'VERSION'))).trim();
  if (packageInfo.name !== 'notnative-desktop' || !/^\d{8}-[1-9]\d{0,5}$/u.test(version)
    || packageInfo.nnd_version !== version || packageInfo.version !== version.replace('-', '.0.') || packageInfo.type !== 'module') throw new Error('payload-version-invalid');
  // Compatibility: pnpm's dependency root may be a junction; its resolved distribution must contain plain files only.
  const dependency = await realpath(join(root, 'packages/electron/node_modules/electron'));
  const electron = await noLinks(join(dependency, 'dist'));
  const runtimeMetadata = await readElectronDependencyMetadata(dependency);
  const runtime = JSON.parse(runtimeMetadata);
  if (runtime.name !== 'electron' || (await metadata(join(electron, 'version'))).trim() !== runtime.version) throw new Error('payload-electron-identity-invalid');
  await verifyWindowsX64(join(electron, 'electron.exe'));
  let files = await inventory(join(root, 'packages/web/dist'), 'packages/web/dist');
  files.push(...await inventory(join(root, 'packages/electron/dist-server'), 'packages/electron/dist-server'));
  files.push(...await inventory(join(root, 'packages/electron/assets'), 'packages/electron/assets'));
  files.push(...await inventory(electron, 'packages/electron/node_modules/electron/dist'));
  const shell = await readdir(join(root, 'packages/electron'), { withFileTypes: true });
  if (shell.length > PAYLOAD_LIMITS.files) throw new Error('payload-shell-limit');
  for (const entry of shell) {
    if (entry.name === 'package.json' || entry.name.endsWith('.mjs') && !/\.(?:test|fixture)\.mjs$/u.test(entry.name)) {
      files.push({ path: `packages/electron/${entry.name}`, source: join(root, 'packages/electron', entry.name) });
    }
  }
  for (const name of SCRIPTS) files.push({ path: `scripts/${name}`, source: join(root, 'scripts', name) });
  files.push({ path: 'packages/electron/build-stamp.json', source: join(root, 'packages/electron/build-stamp.json') });
  files = validateEntries(files);
  requireRuntimeFiles(files);
  let total = 0;
  for (const entry of files) {
    entry.expected = await transferFile(entry.source);
    total = payloadTotal(total, entry.expected.bytes);
  }
  if (!within(dependency, electron)) throw new Error('payload-electron-path-invalid');
  return { root, dependency, runtimeMetadata, files, version, packageInfo };
}
async function readElectronDependencyMetadata(dependency) {
  const canonical = await noLinks(dependency);
  if (canonical !== dependency) throw new Error('payload-electron-path-invalid');
  // Compatibility: pnpm hardlinks its read-only metadata. This exception never applies to a copied payload file.
  return metadata(join(canonical, 'package.json'), true);
}
export async function verifyElectronDependency(plan) {
  if (await realpath(join(plan.root, 'packages/electron/node_modules/electron')) !== plan.dependency
    || await readElectronDependencyMetadata(plan.dependency) !== plan.runtimeMetadata) throw new Error('payload-electron-identity-changed');
}
function requireRuntimeFiles(files) {
  const required = ['packages/electron/main.mjs', 'packages/electron/preload.mjs', 'packages/electron/package.json',
    'packages/web/dist/index.html', 'packages/electron/dist-server/server.mjs', 'packages/electron/dist-server/settings-registry.json',
    'packages/electron/assets/tray-running.png', 'packages/electron/assets/tray-stopped.png'];
  const pty = 'packages/electron/dist-server/node_modules/node-pty/';
  required.push(...['package.json', 'lib/index.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
    'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/winpty-agent.exe', 'prebuilds/win32-x64/winpty.dll',
    'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe'].map((name) => pty + name));
  const runtime = 'packages/electron/node_modules/electron/dist/';
  required.push(...['electron.exe', 'version', 'resources/default_app.asar', 'locales/en-US.pak',
    'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'resources.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
    'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json',
    'vulkan-1.dll', 'LICENSE', 'LICENSES.chromium.html'].map((name) => runtime + name));
  const actual = new Set(files.map((file) => file.path));
  if (required.some((file) => !actual.has(file))) throw new Error('payload-runtime-incomplete');
}
async function verifyWindowsX64(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(64), pe = Buffer.alloc(6);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.readUInt16LE(0) !== 0x5a4d) throw new Error('payload-electron-platform-invalid');
    const offset = header.readUInt32LE(60);
    if (offset > 1024 * 1024 || (await handle.read(pe, 0, 6, offset)).bytesRead !== 6
      || pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) throw new Error('payload-electron-platform-invalid');
  } finally { await handle.close(); }
}
