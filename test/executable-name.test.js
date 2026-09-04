// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { portableExecutableName } from '../src/reliability/executable-name.js';

test('portable executable names normalize padding, quotes, and trailing separators', () => {
  assert.equal(portableExecutableName('  "C:\\Program Files\\Chrome.exe"  '), 'chrome');
  assert.equal(portableExecutableName('chrome.exe '), 'chrome');
  assert.equal(portableExecutableName('/usr/bin/chrome/'), 'chrome');
});
