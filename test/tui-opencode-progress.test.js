// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleOpencodeCommand, handleOpencodeSelection } from '../src/tui/opencode-command.js';

const status = (running) => ({ service: { autostart_enabled: true }, runtime: running ? { running: true, pid: 42, url: 'http://127.0.0.1:4095' } : { running: false },
  login: { installed: true, script_path: 'C:/x.vbs' }, environment: { host: 'http://127.0.0.1:4095' } });

/** Records every overlay painted, in order, and when in the action it happened. */
function workspace(actions) {
  const painted = [];
  let running = false;
  return {
    painted,
    projection: {
      openOverlay: (value) => painted.push({ lines: value.lines, at: actions.started }),
      requestRender: () => { actions.renders += 1; },
    },
    async opencodeCommand([action]) {
      if (action === 'status') return status(running);
      if (action === 'start') { actions.started = 'during-start'; running = true; return { started: true }; }
      if (action === 'stop') { actions.started = 'during-stop'; running = false; return { stopped: true }; }
      return { ...actions.result };
    },
  };
}

test('a start paints progress before it finishes and the outcome after', async () => {
  const actions = { started: 'idle', renders: 0 };
  const fixture = workspace(actions);
  await handleOpencodeSelection('start', fixture);

  // Why two paints: the first is what the operator sees while the process starts.
  assert.equal(fixture.painted.length, 2);
  const [progress, outcome] = fixture.painted;
  assert.match(progress.lines.join('\n'), /Starting the OpenCode service/u);
  assert.match(outcome.lines.join('\n'), /started; the OpenChamber binding is current/u);
  // The progress paint carries no result yet, and the outcome carries no pending line.
  assert.doesNotMatch(progress.lines.join('\n'), /binding is current/u);
  assert.doesNotMatch(outcome.lines.join('\n'), /Starting the OpenCode service/u);
  // Both repaint, so the menu is neither inert nor stale.
  assert.equal(actions.renders, 2);
});

test('a stop says it is stopping, and a slash command behaves the same', async () => {
  const actions = { started: 'idle', renders: 0 };
  const fixture = workspace(actions);
  await handleOpencodeCommand('stop', fixture);
  const text = fixture.painted.map((entry) => entry.lines.join('\n')).join('\n---\n');
  assert.match(text, /Stopping the OpenCode service and clearing the OpenChamber binding/u);
  assert.match(text, /stopped; the OpenChamber binding was cleared/u);
});

test('status paints once, with no progress line', async () => {
  const actions = { started: 'idle', renders: 0 };
  const fixture = workspace(actions);
  await handleOpencodeCommand('', fixture);
  assert.equal(fixture.painted.length, 1);
  assert.doesNotMatch(fixture.painted[0].lines.join('\n'), /\.\.\.$/mu);
});

test('an enable or disable says what it is doing', async () => {
  for (const [action, expected] of [['enable', /Installing the sign-in script/u], ['disable', /Removing the sign-in script/u]]) {
    const fixture = workspace({ started: 'idle', renders: 0, result: {} });
    await handleOpencodeSelection(action, fixture);
    assert.match(fixture.painted[0].lines.join('\n'), expected);
  }
});

test('a workspace without the render callback still paints', async () => {
  // Why: the callback is an optimization for mid-action repaint, never a requirement.
  const painted = [];
  const fixture = {
    projection: { openOverlay: (value) => painted.push(value) },
    opencodeCommand: async ([action]) => (action === 'status' ? status(false) : { started: true }),
  };
  await handleOpencodeSelection('start', fixture);
  assert.equal(painted.length, 2);
  assert.match(painted[0].lines.join('\n'), /Starting the OpenCode service/u);
});
