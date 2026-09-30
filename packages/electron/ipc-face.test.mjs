// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesDesktopLocalOrigin, matchesTrustedOrigin } from './trusted-origin.mjs';

test('matches trusted custom and network origins without accepting lookalikes', () => {
  assert.equal(matchesTrustedOrigin('notnative-ui://app/index.html', 'notnative-ui://app'), true);
  assert.equal(matchesTrustedOrigin('notnative-ui://app.evil/index.html', 'notnative-ui://app'), false);
  assert.equal(matchesTrustedOrigin('notnative-ui://user@app/index.html', 'notnative-ui://app'), false);
  assert.equal(matchesTrustedOrigin('http://127.0.0.1:43123/chat', 'http://127.0.0.1:43123'), true);
  assert.equal(matchesTrustedOrigin('http://127.0.0.1:43124/chat', 'http://127.0.0.1:43123'), false);
});

test('desktop-local origin excludes network UI origins and requires the invoking frame itself', () => {
  const localOrigin = 'http://127.0.0.1:43123';
  const remoteUiOrigin = 'https://remote.example';
  const packagedUiOrigin = 'notnative-ui://app';
  assert.equal(matchesDesktopLocalOrigin('https://remote.example/index.html', localOrigin, remoteUiOrigin), false);
  assert.equal(matchesDesktopLocalOrigin('http://127.0.0.1:43123/index.html', localOrigin, remoteUiOrigin), true);
  assert.equal(matchesDesktopLocalOrigin('notnative-ui://app/index.html', localOrigin, packagedUiOrigin), true);
  // A remote top-level caller stays remote even if event.frames also contains
  // a trusted local iframe; the IPC policy must pass senderFrame.url, not the
  // full frame list, to this origin matcher.
  assert.equal(matchesDesktopLocalOrigin('https://remote.example/index.html', localOrigin, packagedUiOrigin), false);
});
