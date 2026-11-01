// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathIdentity, pathIdentityKey } from '../src/path-identity.js';

test('windows identity resolves before folding case', () => {
  assert.equal(pathIdentity('C:\\Work\\Project', 'c:/work/project', 'win32'), true);
  assert.equal(pathIdentity('C:\\Work\\Project', 'C:\\Work\\Other', 'win32'), false);
  assert.equal(pathIdentity('C:\\Work\\Project\\..\\Project', 'C:/Work/Project', 'win32'), true);
});

test('posix identity is exact after resolution', () => {
  assert.equal(pathIdentity('/srv/work', '/srv/work/', 'linux'), true);
  assert.equal(pathIdentity('/srv/Work', '/srv/work', 'linux'), false);
  assert.equal(pathIdentity('/srv/work/../work', '/srv/work', 'linux'), true);
});

test('missing and empty paths never compare equal', () => {
  assert.equal(pathIdentity(null, null, 'win32'), false);
  assert.equal(pathIdentity('', '', 'win32'), false);
  assert.equal(pathIdentity('C:\\work', undefined, 'win32'), false);
  assert.equal(pathIdentity(undefined, 'C:\\work', 'win32'), false);
});

test('identity keys are resolved, platform-correct, and fail closed', () => {
  assert.equal(pathIdentityKey('C:\\Work\\..\\Work\\A', 'win32'), 'c:\\work\\a');
  assert.equal(pathIdentityKey('/srv/Work/../Work/A', 'linux'), '/srv/Work/A');
  assert.throws(() => pathIdentityKey('', 'win32'), { code: 'path_identity_invalid' });
  assert.throws(() => pathIdentityKey(null, 'linux'), { code: 'path_identity_invalid' });
});
