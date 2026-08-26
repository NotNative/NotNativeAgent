// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfirmationOverlay, createDetailOverlay, createMenuOverlay, overlayControlLabel } from '../src/tui/surface-engine.js';

test('shared menu surface selects by stable id and freezes its presentation contract', () => {
  const overlay = createMenuOverlay('example', 'Example', ['Choose one.'], [
    { id: 'one', label: 'One' }, { id: 'two', label: 'Two' },
  ], { activeId: 'two' });
  assert.equal(overlay.selected, 1);
  assert.equal(overlay.navigation, 'menu');
  assert.equal(Object.isFrozen(overlay.items), true);
  assert.equal(Object.isFrozen(overlay.items[0]), true);
});

test('shared detail and confirmation surfaces apply their navigation and safe defaults', () => {
  const detail = createDetailOverlay('detail', 'Detail', [], [{ id: 'edit', label: 'Edit' }]);
  assert.equal(detail.navigation, 'detail');
  const confirmation = createConfirmationOverlay('confirm', 'Confirm', [], [
    { id: 'delete', label: 'Delete' }, { id: 'keep', label: 'Keep' },
  ], { safeId: 'keep' });
  assert.equal(confirmation.navigation, 'confirm');
  assert.equal(confirmation.items[confirmation.selected].id, 'keep');
});

test('shared surface footer generates navigation once without duplicate Escape instructions', () => {
  assert.equal(
    overlayControlLabel({ navigation: 'menu', items: [{}] }),
    'Up/Down choose · Enter select · Esc back · Ctrl+G/Ctrl+C close',
  );
  assert.equal(
    overlayControlLabel({ actionLabel: 'Type value · Enter continue · Esc previous' }),
    'Type value · Enter continue · Esc previous · Ctrl+G/Ctrl+C close',
  );
});
