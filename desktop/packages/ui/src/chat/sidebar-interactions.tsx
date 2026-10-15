// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useSidebarPreference } from './sidebar-preferences.ts';

export function useSidebarInteractions(onDismiss: () => void) {
  const root = useRef<HTMLElement>(null);
  const [width, setWidth] = useSidebarPreference('width', 288, (value): value is number => typeof value === 'number' && value >= 220 && value <= 480);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const target = event.target as Element | null;
      root.current?.querySelectorAll('details[open]').forEach(details => {
        if (event.type === 'keydown' || !target || !details.contains(target)) details.removeAttribute('open');
      });
      if (event.type === 'keydown' || !target?.closest('[data-testid="sidebar-filter-menu"], [aria-label="Filter conversations"]')) onDismiss();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') close(event); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, [onDismiss]);
  const resize = (value: number) => setWidth(Math.max(220, Math.min(480, value)));
  const grip = <div role="separator" aria-label="Resize workspace sidebar" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={220} aria-valuemax={480} tabIndex={0}
    className="absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize touch-none hover:bg-sky-500/40 focus:bg-sky-500/40"
    onPointerDown={event => { drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
    onPointerMove={event => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }}
    onPointerUp={event => { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); resize(event.key === 'Home' ? 220 : event.key === 'End' ? 480 : width + (event.key === 'ArrowRight' ? 24 : -24));
      }
    }} />;
  return { root, width, grip };
}

export function moveWorkspaceOrder(directories: string[], directory: string, distance: -1 | 1): string[] {
  const next = [...directories]; const from = next.indexOf(directory); const to = from + distance;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next.slice(0, 256);
}
export const workspaceOrderList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(row => typeof row === 'string' && row.length <= 4096) && new Set(value).size === value.length;
