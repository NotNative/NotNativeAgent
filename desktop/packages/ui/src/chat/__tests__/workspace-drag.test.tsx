// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { reorderWorkspace, useWorkspaceDrag } from '../workspace-drag.tsx';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
it('moves to the target position and ignores missing or identical roots', () => {
  expect(reorderWorkspace(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  expect(reorderWorkspace(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(reorderWorkspace(['a', 'b'], 'missing', 'b')).toEqual(['a', 'b']);
  expect(reorderWorkspace(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
});
it('drops only on workspace rows and supports keyboard reordering', () => {
  const move = vi.fn(), nudge = vi.fn();
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  function Probe() { const drag = useWorkspaceDrag(move, nudge); return <><section data-workspace-root="a">{drag.handle('a', 'Alpha')}</section><section data-workspace-root="b" /></>; }
  act(() => root.render(<Probe />));
  const grip = node.querySelector('button')!; grip.setPointerCapture = vi.fn(); grip.releasePointerCapture = vi.fn(); grip.hasPointerCapture = vi.fn(() => true);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => node.querySelector('[data-workspace-root="b"]')) });
  const pointer = (type: string) => { const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 1, clientY: 1 }); Object.defineProperty(event, 'pointerId', { value: 1 }); act(() => grip.dispatchEvent(event)); };
  pointer('pointerdown'); pointer('pointermove'); pointer('pointerup'); expect(move).toHaveBeenCalledWith('a', 'b');
  move.mockClear(); pointer('pointerdown'); pointer('pointercancel'); pointer('pointerup'); expect(move).not.toHaveBeenCalled();
  act(() => grip.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })));
  expect(nudge).toHaveBeenCalledWith('a', 1);
  act(() => root.unmount()); node.remove(); delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
});
