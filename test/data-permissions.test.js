// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDataPermissions } from '../src/data-permissions.js';

test('AC-PRIV-04 POSIX permission inspection warns on group or other access', async () => {
  const secure = await inspectDataPermissions('/data', {
    platform: 'linux', stat: async () => ({ mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false }),
  });
  const exposed = await inspectDataPermissions('/data', {
    platform: 'linux', stat: async () => ({ mode: 0o40755, isDirectory: () => true, isSymbolicLink: () => false }),
  });
  assert.deepEqual(secure, { status: 'ready', root: '/data', mode: '0700' });
  assert.equal(exposed.status, 'degraded');
  assert.match(exposed.warning, /group or other/u);
});

test('POSIX permission inspection rejects files and symlinked data roots', async () => {
  for (const info of [
    { mode: 0o100600, isDirectory: () => false, isSymbolicLink: () => false },
    { mode: 0o40700, isDirectory: () => false, isSymbolicLink: () => true },
  ]) {
    const status = await inspectDataPermissions('/data', { platform: 'linux', lstat: async () => info });
    assert.equal(status.status, 'degraded');
    assert.equal(status.code, 'data_root_not_private_directory');
  }
});

test('AC-PRIV-04 Windows reports native ACL verification status truthfully', async () => {
  const status = await inspectDataPermissions('C:\\Users\\operator\\.nna', { platform: 'win32' });
  assert.equal(status.status, 'unknown');
  assert.equal(status.enforcement, 'windows_installer_acl');
  assert.match(status.warning, /native Windows release audit/u);
});
