// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesTrustedOrigin } from './trusted-origin.mjs';

test('matches trusted custom and network origins without accepting lookalikes', () => {
  assert.equal(matchesTrustedOrigin('notnative-ui://app/index.html', 'notnative-ui://app'), true);
  assert.equal(matchesTrustedOrigin('notnative-ui://app.evil/index.html', 'notnative-ui://app'), false);
  assert.equal(matchesTrustedOrigin('notnative-ui://user@app/index.html', 'notnative-ui://app'), false);
  assert.equal(matchesTrustedOrigin('http://127.0.0.1:43123/chat', 'http://127.0.0.1:43123'), true);
  assert.equal(matchesTrustedOrigin('http://127.0.0.1:43124/chat', 'http://127.0.0.1:43123'), false);
});
