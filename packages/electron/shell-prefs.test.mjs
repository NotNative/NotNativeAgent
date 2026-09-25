// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { readShellPrefs, writeShellPrefs } from './shell-prefs.mjs';

test('updates one shell preference without dropping another', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nnd-prefs-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'prefs.json');
  writeShellPrefs(file, { port: 57123 });
  writeShellPrefs(file, { windowState: { x: 20, y: 30, width: 900, height: 600 } });
  assert.deepEqual(readShellPrefs(file), {
    port: 57123, windowState: { x: 20, y: 30, width: 900, height: 600 },
  });
});

test('a failed replace leaves the previous port and geometry intact', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nnd-prefs-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'prefs.json');
  writeShellPrefs(file, { port: 57123, windowState: { x: 20 } });
  const oldText = fs.readFileSync(file, 'utf8');
  const replacement = mock.method(fs, 'renameSync', () => { throw new Error('simulated replace failure'); });
  try {
    assert.throws(() => writeShellPrefs(file, { port: 12345 }), /simulated replace failure/);
  } finally {
    replacement.mock.restore();
  }
  assert.equal(fs.readFileSync(file, 'utf8'), oldText);
  assert.deepEqual(fs.readdirSync(directory), ['prefs.json']);
});

test('malformed preferences are treated as absent and replaced on next write', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nnd-prefs-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'prefs.json');
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(readShellPrefs(file), {});
  writeShellPrefs(file, { port: 57123 });
  assert.deepEqual(readShellPrefs(file), { port: 57123 });
});
