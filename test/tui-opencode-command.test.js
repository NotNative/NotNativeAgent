// SPDX-License-Identifier: Apache-2.0
// The OpenCode service TUI surface: the same operator control the Telegram
// gateway gets, over the OpenChamber wiring service. These tests pin the
// overlay's honesty (running state, binding staleness), the action arity, and
// the lifecycle delegation to the service commands.
import assert from 'node:assert/strict';
import test from 'node:test';
import { opencodeOverlay } from '../src/tui/overlays.js';
import { commandDefinition } from '../src/tui/commands.js';
import { handleOpencodeCommand } from '../src/tui/opencode-command.js';

test('the opencode service appears in configuration with an actionable overlay', () => {
  assert.equal(commandDefinition('/opencode').name, '/opencode');
  const view = opencodeOverlay({
    service: { autostart_enabled: false },
    runtime: { running: true, pid: 39408, url: 'http://127.0.0.1:4095', verified: true },
    login: { installed: true, script_path: 'C:\\startup\\NotNativeAgent-OpenCode.vbs' },
    environment: { supported: true, host: 'http://127.0.0.1:4095', password_present: true, username: null },
    stale_binding: false,
  });
  assert.equal(view.kind, 'opencode');
  assert.match(view.lines.join('\n'), /running \(PID 39408\) at http:\/\/127\.0\.0\.1:4095/u);
  assert.match(view.lines.join('\n'), /Binding {6}http:\/\/127\.0\.0\.1:4095/u);
  assert.match(view.lines.join('\n'), /Sign-in {6}installed/u);
  // A running surface offers stop, not start.
  assert.equal(view.items.some((item) => item.id === 'stop'), true);
  assert.equal(view.items.some((item) => item.id === 'start'), false);
});

test('the overlay names a stale binding and offers start when stopped', () => {
  const stopped = opencodeOverlay({
    service: { autostart_enabled: true }, runtime: { running: false },
    login: { installed: false, script_path: null },
    environment: { supported: true, host: null, password_present: false, username: null },
    stale_binding: false,
  });
  assert.equal(stopped.items.some((item) => item.id === 'start'), true);
  assert.equal(stopped.items.some((item) => item.id === 'disable'), true,
    'an enabled service offers disable at sign-in');
  const stale = opencodeOverlay({
    service: { autostart_enabled: false },
    runtime: { running: true, pid: 1, url: 'http://127.0.0.1:4095' },
    login: { installed: false, script_path: null },
    environment: { supported: true, host: 'http://127.0.0.1:9999', password_present: true, username: null },
    stale_binding: true,
  });
  assert.match(stale.lines.join('\n'), /\(stale\)/u, 'a diverged binding is named, not hidden');
});

test('TUI opencode commands delegate to the service actions and enforce arity', async () => {
  const calls = [];
  const workspace = {
    opencodeCommand: async (args) => { calls.push(args); return { started: true, pid: 1, url: 'http://127.0.0.1:4095' }; },
    projection: { openOverlay: () => undefined },
  };
  for (const command of ['run', 'token x', 'start extra']) {
    await assert.rejects(handleOpencodeCommand(command, workspace), { code: 'opencode_tui_command_invalid' });
  }
  // No argument is a status call, matching the gateway surface's convention.
  await handleOpencodeCommand('', workspace);
  assert.deepEqual(calls[0], ['status']);
  await handleOpencodeCommand('start', workspace);
  assert.deepEqual(calls[2], ['start']);
  // The overlay always re-reads status after the action.
  assert.deepEqual(calls[3], ['status']);
});
