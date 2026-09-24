// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCli } from '../src/cli-options.js';
import { runOpencodeCommand } from '../src/opencode/cli-operation.js';

test('opencode enable parses hostname and port', () => {
  const parsed = parseCli(['opencode', 'enable', '--hostname', '127.0.0.1', '--port', '4055']);
  assert.equal(parsed.mode, 'opencode');
  assert.equal(parsed.serveAction, 'enable');
  assert.equal(parsed.serveHostname, '127.0.0.1');
  assert.equal(parsed.servePort, 4055);
});

test('opencode enable rejects unavailable or malformed ports', () => {
  assert.throws(() => parseCli(['opencode', 'enable', '--port', '0']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', 'enable', '--port', '70000']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', 'enable', '--port', 'banana']), { code: 'invalid_option' });
  assert.throws(() => parseCli(['opencode', 'enable', '--port']), { code: 'option_value_missing' });
});

test('opencode without an action yields the lifecycle-action guard at the CLI layer', () => {
  const parsed = parseCli(['opencode']);
  assert.equal(parsed.mode, 'opencode');
  assert.equal(parsed.serveAction, null);
});

test('opencode lifecycle actions parse into single actions', () => {
  for (const action of ['status', 'start', 'stop', 'enable', 'disable', 'run']) {
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

test('opencode serve is no longer an available action', () => {
  const parsed = parseCli(['opencode', 'serve']);
  assert.equal(parsed.serveAction, null);
  assert.deepEqual(parsed.prompt, ['serve']);
});

test('runOpencodeCommand rejects a missing or unknown action with exit code 2', async () => {
  const written = [];
  const code = await runOpencodeCommand({ serveAction: 'deploy' }, {}, {
    diagnostics: { write: (message) => written.push(message) },
  });
  assert.equal(code, 2);
  assert.match(written.join(''), /valid actions are/u);
});
