// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { captureWindowState, restoreWindowState } from './window-state.mjs';

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const second = { x: 1920, y: 0, width: 1280, height: 900 };

test('restores a window on its overlapping display and preserves mode flags', () => {
  const restored = restoreWindowState({ x: 2200, y: 120, width: 1000, height: 700, maximized: true }, [primary, second]);
  assert.deepEqual(restored, { bounds: { x: 2200, y: 120, width: 1000, height: 700 }, maximized: true, fullscreen: false });
});

test('removed displays and huge windows re-anchor inside the primary work area', () => {
  const restored = restoreWindowState({ x: 4000, y: 900, width: 4000, height: 3000, fullscreen: true }, [primary]);
  assert.deepEqual(restored, { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, maximized: false, fullscreen: true });
});

test('small saved windows respect restore minimums and invalid state is discarded', () => {
  assert.deepEqual(restoreWindowState({ x: 50, y: 50, width: 400, height: 200 }, [primary])?.bounds,
    { x: 50, y: 50, width: 900, height: 560 });
  assert.equal(restoreWindowState({ x: '50', y: 0, width: 900, height: 560 }, [primary]), null);
  assert.equal(restoreWindowState({ x: 0, y: 0, width: 900, height: 560 }, []), null);
  assert.equal(captureWindowState({ x: 0, y: 0, width: 0, height: 560 }, false, false), null);
});

test('captures the normal bounds, not maximized display bounds', () => {
  assert.deepEqual(captureWindowState({ x: 20, y: 30, width: 700, height: 510 }, true, false),
    { x: 20, y: 30, width: 800, height: 520, maximized: true, fullscreen: false });
});

test('fullscreen takes precedence if the platform reports both window modes', () => {
  const saved = captureWindowState({ x: 20, y: 30, width: 1000, height: 700 }, true, true);
  assert.equal(saved.maximized, false);
  assert.equal(saved.fullscreen, true);
  assert.deepEqual(restoreWindowState({ ...saved, maximized: true }, [primary]), {
    bounds: { x: 20, y: 30, width: 1000, height: 700 }, maximized: false, fullscreen: true,
  });
});
