// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionLines } from '../src/tui/permission-renderer.js';

const bindings = { allow_once: 'ctrl+y', cancel: 'ctrl+c' };

test('permission rendering tolerates malformed optional diagnostic fields', () => {
  const argumentsValue = {};
  argumentsValue.circular = argumentsValue;
  const lines = permissionLines({
    tool: 'fs.write_text', choices: ['allow_once', 'deny', 'cancel'],
    arguments: argumentsValue, expires_at: 'invalid',
  }, 100, bindings);
  assert.match(lines.join('\n'), /Arguments: \[unavailable\]/u);
  assert.match(lines.join('\n'), /Expires: not provided/u);
  assert.match(lines.join('\n'), /Ctrl\+Y  APPROVE ONCE/u);
});
