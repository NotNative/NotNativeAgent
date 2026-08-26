// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormOverlay, formField, handleFormEditing } from '../src/tui/form-engine.js';

test('shared TUI form engine standardizes editing, masking, progress, and character feedback', () => {
  const form = { stepIndex: 0, draft: {}, steps: [
    formField('token', 'Access token', 'Paste the write-only token.', { secret: true, limit: 128 }),
  ] };
  let overlay = createFormOverlay(form, { kind: 'test-form', title: 'Test form' });
  assert.equal(handleFormEditing({ action: 'insert', text: 'abc' }, overlay.editor), true);
  overlay = createFormOverlay(form, { kind: 'test-form', title: 'Test form' }, overlay.editor);
  assert.doesNotMatch(overlay.lines.join('\n'), /abc/u);
  assert.match(overlay.lines.join('\n'), /\*\*\*\u2502/u);
  assert.match(overlay.lines.join('\n'), /3 characters entered/u);
});

test('shared TUI form engine normalizes single-line paste and supports standard movement', () => {
  const form = { step: 0, draft: {}, steps: [formField('label', 'Label', 'Visible label.')] };
  const overlay = createFormOverlay(form, { kind: 'test-form', title: 'Test form' });
  assert.equal(handleFormEditing({ action: 'paste', text: 'first\r\nsecond' }, overlay.editor), true);
  assert.equal(overlay.editor.text, 'first');
  assert.equal(handleFormEditing({ action: 'home' }, overlay.editor), true);
  assert.equal(overlay.editor.cursor, 0);
});
