// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCli } from '../src/cli-options.js';

test('opencode serve parses hostname, port, and advertised version', () => {
  const parsed = parseCli(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', '4055', '--advertise-version', '1.18.31']);
  assert.equal(parsed.mode, 'opencode');
  assert.equal(parsed.serveAction, 'serve');
  assert.equal(parsed.serveHostname, '127.0.0.1');
  assert.equal(parsed.servePort, 4055);
  assert.equal(parsed.advertiseVersion, '1.18.31');
});

test('opencode serve rejects out-of-range ports and malformed values', () => {
  assert.throws(() => parseCli(['opencode', 'serve', '--port', '70000']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', 'serve', '--port', 'banana']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', 'serve', '--port']), { code: 'option_value_missing' });
});

test('opencode without an action yields the serve-action guard at the CLI layer', () => {
  const parsed = parseCli(['opencode']);
  assert.equal(parsed.mode, 'opencode');
  assert.equal(parsed.serveAction, null);
});

test('unchanged modes keep their parse behavior', () => {
  const parsed = parseCli(['tui']);
  assert.equal(parsed.mode, 'tui');
  assert.equal(parsed.servePort, null);
});
