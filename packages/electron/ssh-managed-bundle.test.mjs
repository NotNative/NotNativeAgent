import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createManagedSshBundle, MANAGED_BUNDLE_LIMIT_BYTES } from './ssh-managed-bundle.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notnative-managed-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const web = path.join(root, 'web');
  mkdirSync(path.join(web, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'server.mjs'), 'export const server = true;');
  writeFileSync(path.join(root, 'settings.json'), '{}');
  writeFileSync(path.join(web, 'index.html'), '<main>ok</main>');
  writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log("ok")');
  return { serverBundlePath: path.join(root, 'server.mjs'), settingsRegistryPath: path.join(root, 'settings.json'), webDistPath: web };
}

function unpack(gzip) {
  const tar = gunzipSync(gzip);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    const dataStart = offset + 512;
    files.set(name, tar.subarray(dataStart, dataStart + size).toString('utf8'));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('managed SSH bundle contains server, runtime manifest, launcher, and web assets', (t) => {
  const files = unpack(createManagedSshBundle(fixture(t)));
  assert.equal(files.get('server.mjs'), 'export const server = true;');
  assert.equal(files.get('settings-registry.json'), '{}');
  assert.match(files.get('package.json'), /"trustedDependencies":\["node-pty"\]/u);
  assert.match(files.get('start-managed.mjs'), /startServer/);
  assert.equal(files.get('web-dist/index.html'), '<main>ok</main>');
  assert.equal(files.get('web-dist/assets/app.js'), 'console.log("ok")');
});

test('managed SSH bundle enforces its uncompressed size bound', (t) => {
  assert.throws(() => createManagedSshBundle({ ...fixture(t), maxBytes: 1 }), /managed-bundle-too-large/);
  assert.throws(() => createManagedSshBundle({ ...fixture(t), maxBytes: Infinity }), /managed-bundle-limit-invalid/);
});

test('managed SSH bundle checks file sizes before reading and rejects symlinked inputs', (t) => {
  const input = fixture(t);
  truncateSync(input.serverBundlePath, MANAGED_BUNDLE_LIMIT_BYTES + 1);
  assert.throws(() => createManagedSshBundle(input), /managed-bundle-too-large/);

  const linked = path.join(path.dirname(input.serverBundlePath), 'linked-server.mjs');
  try { symlinkSync(input.settingsRegistryPath, linked); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlinks unavailable'); throw error; }
  assert.throws(() => createManagedSshBundle({ ...input, serverBundlePath: linked }), /managed-bundle-symlink-rejected/);
});

test('managed SSH bundle rejects symbolic links in web assets', (t) => {
  const input = fixture(t);
  const link = path.join(input.webDistPath, 'linked.js');
  try { symlinkSync(path.join(input.webDistPath, 'index.html'), link); }
  catch (error) { if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlinks unavailable'); throw error; }
  assert.throws(() => createManagedSshBundle(input), /managed-bundle-symlink-rejected/);
});
