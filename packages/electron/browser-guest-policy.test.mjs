// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allowedGuestPartition, allowedGuestUrl, hardenGuestPreferences } from './browser-guest-policy.mjs';

const own = 'http://127.0.0.1:57123';
test('packaged shell includes the guest policy imported by main', () => {
  const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.build.files.includes('browser-guest-policy.mjs'));
});

test('guest must request the isolated, in-memory partition', () => {
  assert.equal(allowedGuestPartition({ partition: 'nnd-preview' }), true);
  for (const partition of [undefined, '', 'persist:shared', 'nnd-main']) {
    assert.equal(allowedGuestPartition({ partition }), false);
  }
});
test('guest URL policy permits HTTPS and loopback HTTP but never app/auth or local files', () => {
  for (const url of ['https://example.org/', 'http://localhost:5173/', 'http://127.0.0.1:5173/', 'http://[::1]:5173/']) {
    assert.equal(allowedGuestUrl(url, own), true, url);
  }
  for (const url of ['http://example.org/', 'file:///C:/secret', 'javascript:alert(1)', 'data:text/html,a',
    'http://127.0.0.1:57123/', 'http://localhost:57123/', 'https://user:pass@example.org/']) {
    assert.equal(allowedGuestUrl(url, own), false, url);
  }
});

test('guest preferences cannot carry a renderer-provided preload or privileges', () => {
  const preferences = { preload: 'C:/evil.js', preloadURL: 'C:/evil.js', nodeIntegration: true,
    contextIsolation: false, sandbox: false, webSecurity: false, allowRunningInsecureContent: true };
  const params = { preload: 'C:/evil.js', allowpopups: 'yes', partition: 'persist:shared' };
  hardenGuestPreferences(preferences, params);
  assert.equal('preload' in preferences, false);
  assert.equal('preloadURL' in preferences, false);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.webSecurity, true);
  assert.equal(preferences.allowRunningInsecureContent, false);
  assert.equal(params.partition, 'nnd-preview');
  assert.equal('preload' in params, false);
  assert.equal('allowpopups' in params, false);
});
