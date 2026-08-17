// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { inlineInterpreterGuidance, inlineInterpreterInvocation } from '../src/reliability/command-shaping.js';

test('inline interpreter shaping recognizes fragile source argv without blocking stdin forms', () => {
  assert.equal(inlineInterpreterInvocation('node.exe', ['-e', 'console.log(1)']), true);
  assert.equal(inlineInterpreterInvocation('C:\\Program Files\\nodejs\\node.exe', ['-e', 'console.log(1)']), true);
  assert.equal(inlineInterpreterInvocation('/usr/local/bin/python3', ['-c', 'print(1)']), true);
  assert.equal(inlineInterpreterInvocation('python3', ['-c', 'print(1)']), true);
  assert.equal(inlineInterpreterInvocation('node', ['-', 'argument']), false);
  assert.equal(inlineInterpreterInvocation('python', ['-', 'argument']), false);
  assert.equal(inlineInterpreterInvocation('rg', ['-e', 'pattern']), false);
  assert.match(inlineInterpreterGuidance(), /ref\.store.*stdin_ref.*node with args \["-"\]/u);
});
