// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

export function reorderWorkspace(directories: string[], source: string, target: string): string[] {
  const from = directories.indexOf(source), to = directories.indexOf(target);
  if (from < 0 || to < 0 || from === to) return directories;
  const next = [...directories]; next.splice(from, 1); next.splice(to, 0, source); return next.slice(0, 256);
}
export function useWorkspaceDrag(move: (source: string, target: string) => void, nudge: (source: string, distance: -1 | 1) => void) {
  const drag = useRef<{ source: string; runtime: string; target: string | null } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const hit = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-workspace-root]')?.dataset.workspaceRoot ?? null;
  const clear = () => { drag.current = null; setTarget(null); };
  const handle = (directory: string, label: string) => <button type="button" aria-label={`Reorder workspace ${label}`} title="Drag to reorder; Arrow Up or Down to move"
    className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-neutral-500 hover:bg-white/10 hover:text-neutral-200 active:cursor-grabbing"
    onPointerDown={event => {
      if (event.button !== 0) return;
      drag.current = { source: directory, runtime: getRuntimeKey(), target: null };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
    }} onPointerMove={event => {
      if (!drag.current) return;
      drag.current.target = hit(event.clientX, event.clientY); setTarget(drag.current.target);
    }} onPointerUp={event => {
      const current = drag.current, destination = hit(event.clientX, event.clientY);
      clear(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (current && current.runtime === getRuntimeKey() && destination && current.source !== destination) move(current.source, destination);
    }} onLostPointerCapture={clear} onPointerCancel={clear} onKeyDown={event => {
      if (event.key === 'Escape') { clear(); return; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); nudge(directory, event.key === 'ArrowUp' ? -1 : 1); }
    }}><span aria-hidden>⠿</span></button>;
  return { handle, target };
}
