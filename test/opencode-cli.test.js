// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCli } from '../src/cli-options.js';
import { runOpencodeCommand, serveCredentials } from '../src/opencode/cli-operation.js';

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

test('opencode lifecycle actions parse into single serve actions', () => {
  for (const action of ['serve', 'status', 'start', 'stop', 'enable', 'disable', 'run']) {
    const parsed = parseCli(['opencode', action]);
    assert.equal(parsed.serveAction, action);
  }
});

test('opencode enable accepts port and hostname overrides', () => {
  const parsed = parseCli(['opencode', 'enable', '--port', '4939', '--hostname', '0.0.0.0']);
  assert.equal(parsed.serveAction, 'enable');
  assert.equal(parsed.servePort, 4939);
  assert.equal(parsed.serveHostname, '0.0.0.0');
});

test('opencode rejects a second action and unknown options', () => {
  assert.throws(() => parseCli(['opencode', 'start', 'stop']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', 'start', '--mode', 'x']), { code: 'invalid_option' });
});

test('unchanged modes keep their parse behavior', () => {
  const parsed = parseCli(['tui']);
  assert.equal(parsed.mode, 'tui');
  assert.equal(parsed.servePort, null);
});

// Why: OpenChamber derives its Basic header from these names with the default
// username fallback, so the foreground serve must bind the same environment
// identity; a blank username keeps the server default via null.
test('foreground serve credentials follow the OpenChamber environment contract', () => {
  assert.deepEqual(serveCredentials({}), { password: null, username: null });
  assert.deepEqual(serveCredentials({ OPENCODE_SERVER_PASSWORD: ' 2345678901234567890abc ' }), { password: '2345678901234567890abc', username: null });
  assert.deepEqual(serveCredentials({ OPENCODE_SERVER_USERNAME: ' nna-operator ' }), { password: null, username: 'nna-operator' });
  assert.deepEqual(serveCredentials({ OPENCODE_SERVER_USERNAME: '   ' }), { password: null, username: null });
});

test('runOpencodeCommand rejects a missing or unknown action with exit code 2', async () => {
  const written = [];
  const code = await runOpencodeCommand({ serveAction: 'deploy' }, {}, {
    diagnostics: { write: (message) => written.push(message) },
  });
  assert.equal(code, 2);
  assert.match(written.join(''), /valid actions are/u);
});
