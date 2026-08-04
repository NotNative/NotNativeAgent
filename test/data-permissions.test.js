// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDataPermissions } from '../src/data-permissions.js';

test('AC-PRIV-04 POSIX permission inspection warns on group or other access', async () => {
  const secure = await inspectDataPermissions('/data', {
    platform: 'linux', stat: async () => ({ mode: 0o40700 }),
  });
  const exposed = await inspectDataPermissions('/data', {
    platform: 'linux', stat: async () => ({ mode: 0o40755 }),
  });
  assert.deepEqual(secure, { status: 'ready', root: '/data', mode: '0700' });
  assert.equal(exposed.status, 'degraded');
  assert.match(exposed.warning, /group or other/u);
});

test('AC-PRIV-04 Windows reports native ACL verification status truthfully', async () => {
  const status = await inspectDataPermissions('C:\\Users\\operator\\.nna', { platform: 'win32' });
  assert.equal(status.status, 'unknown');
  assert.equal(status.enforcement, 'windows_installer_acl');
  assert.match(status.warning, /native Windows release audit/u);
});
