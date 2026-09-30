// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { readDesktopLocalClientToken, readOrCreateDesktopInstallId } from './desktop-identity.mjs';

const UUID = '53f88b2d-328e-42e6-ace4-3f8172f95a00';

test('desktop install id persists once and repairs malformed stored values', () => {
  let prefs = { desktopInstallId: UUID };
  let writes = 0;
  const services = {
    readPrefs: () => prefs,
    writePrefs: (patch) => { writes += 1; prefs = { ...prefs, ...patch }; },
    generateId: () => UUID,
  };
  assert.equal(readOrCreateDesktopInstallId(services), UUID);
  assert.equal(writes, 0);
  prefs = { desktopInstallId: 'not-a-uuid' };
  assert.equal(readOrCreateDesktopInstallId(services), UUID);
  assert.equal(writes, 1);
  assert.equal(prefs.desktopInstallId, UUID);
});

test('local client token getter returns only a stored string', () => {
  assert.equal(readDesktopLocalClientToken(() => ({ desktopLocalClientToken: 'token' })), 'token');
  assert.equal(readDesktopLocalClientToken(() => ({ desktopLocalClientToken: '  token  ' })), 'token');
  assert.equal(readDesktopLocalClientToken(() => ({ desktopLocalClientToken: null })), '');
  assert.equal(readDesktopLocalClientToken(() => ({})), '');
  assert.equal(readDesktopLocalClientToken(() => ({ desktopLocalClientToken: 'bad\ntoken' })), '');
  assert.equal(readDesktopLocalClientToken(() => ({ desktopLocalClientToken: 'x'.repeat(8_193) })), '');
});

test('install id getter replaces malformed UUID variants and rejects invalid generators', () => {
  for (const malformed of ['00000000-0000-0000-0000-000000000000', '53f88b2d-328e-42e6-0ce4-3f8172f95a00', `${UUID} `]) {
    let prefs = { desktopInstallId: malformed };
    let writes = 0;
    assert.equal(readOrCreateDesktopInstallId({
      readPrefs: () => prefs,
      writePrefs: (patch) => { writes += 1; prefs = { ...prefs, ...patch }; },
      generateId: () => UUID,
    }), UUID);
    assert.equal(writes, 1);
    assert.equal(prefs.desktopInstallId, UUID);
  }
  assert.throws(() => readOrCreateDesktopInstallId({
    readPrefs: () => ({}), writePrefs: () => {}, generateId: () => 'not-a-uuid',
  }), /invalid UUID/u);
});
