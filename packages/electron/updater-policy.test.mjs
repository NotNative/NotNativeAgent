// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUpdaterCapability, compareVersions, resolveUpdaterChannel, resolveUpdaterFeed } from './updater-policy.mjs';

test('updater feed remains production unless an E2E build and runtime opt-in use a loopback URL', () => {
  const production = { provider: 'github', owner: 'openchamber', repo: 'openchamber' };
  assert.deepEqual(resolveUpdaterFeed({}), production);
  assert.deepEqual(resolveUpdaterFeed({ testBuild: true, environment: { OPENCHAMBER_E2E: '1', OPENCHAMBER_UPDATER_E2E_URL: 'http://127.0.0.1:4173/feed/' } }), { provider: 'generic', url: 'http://127.0.0.1:4173/feed' });
  for (const url of ['https://example.com', 'http://127.0.0.1/?x=1', 'http://user@localhost/feed', 'http://127.1.2.3.evil/feed']) {
    assert.deepEqual(resolveUpdaterFeed({ testBuild: true, environment: { OPENCHAMBER_E2E: '1', OPENCHAMBER_UPDATER_E2E_URL: url } }), production);
  }
  assert.deepEqual(resolveUpdaterFeed({ testBuild: false, environment: { OPENCHAMBER_E2E: '1', OPENCHAMBER_UPDATER_E2E_URL: 'http://localhost/feed' } }), production);
});

test('only Windows arm64 selects a non-default update channel', () => {
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'arm64' }), 'latest-arm64');
  assert.equal(resolveUpdaterChannel({ platform: 'win32', architecture: 'x64' }), null);
  assert.equal(resolveUpdaterChannel({ platform: 'darwin', architecture: 'arm64' }), null);
});

test('Linux update capability requires a writable packaged AppImage', () => {
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'win32', packaged: true }));
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'linux', packaged: false }));
  assert.throws(() => assertUpdaterCapability({ platform: 'linux', packaged: true, environment: {} }), /Updates require the packaged Linux AppImage/u);
  assert.throws(() => assertUpdaterCapability({ platform: 'linux', packaged: true, environment: { APPIMAGE: 'relative.AppImage' } }), /not absolute/u);
  const fakeFileSystem = { statSync: () => ({ isFile: () => true }), accessSync: () => { throw new Error('EACCES'); } };
  assert.throws(() => assertUpdaterCapability({ platform: 'linux', packaged: true, environment: { APPIMAGE: '/opt/app.AppImage' }, fs: fakeFileSystem }), /not writable/u);
  const checkedPaths = [];
  assert.doesNotThrow(() => assertUpdaterCapability({ platform: 'linux', packaged: true, environment: { APPIMAGE: '/opt/app.AppImage' }, fs: { statSync: () => ({ isFile: () => true }), accessSync: (path) => checkedPaths.push(path) } }));
  assert.deepEqual(checkedPaths, ['/opt/app.AppImage', '/opt']);
  assert.throws(() => assertUpdaterCapability({
    platform: 'linux', packaged: true, environment: { APPIMAGE: '/opt/app.AppImage' },
    fs: { statSync: () => ({ isFile: () => true }), accessSync: (path) => { if (path === '/opt') throw new Error('EACCES'); } },
  }), /not writable/u);
});

test('version comparison handles v prefix, missing segments, and invalid versions', () => {
  assert.equal(compareVersions('v2.10.0', '2.9'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.1-beta.1', '1.2.0'), 1);
  assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), -1);
  assert.equal(compareVersions('1.2.3-beta.10', '1.2.3-beta.2'), 1);
  assert.equal(compareVersions('20260930-22', '20260930-21'), 1);
  assert.equal(compareVersions('999999999999999999999999.0', '999999999999999999999998.99'), 1);
  assert.equal(compareVersions('latest', '1.0.0'), 0);
});
