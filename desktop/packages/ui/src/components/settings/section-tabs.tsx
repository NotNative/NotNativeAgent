// SPDX-License-Identifier: Apache-2.0
import { useId, useRef, type ReactNode } from 'react';
import { useSettingsLeave } from './edit-boundary.tsx';

export function SettingsTabs({ label, items, value, onChange }: {
  label: string; items: readonly { id: string; title: string }[]; value: string; onChange(id: string): void;
}): ReactNode {
  const leave = useSettingsLeave(), id = useId(), buttons = useRef(new Map<string, HTMLButtonElement>());
  const select = (next: string) => { if (next !== value) leave(() => { onChange(next); buttons.current.get(next)?.focus(); }); };
  return <div role="tablist" aria-label={label} className="flex flex-wrap gap-2 border-b border-border pb-3">
    {items.map((item, index) => <button key={item.id} ref={node => { if (node) buttons.current.set(item.id, node); else buttons.current.delete(item.id); }}
      type="button" role="tab" id={`${id}-${item.id}`} aria-selected={item.id === value} tabIndex={item.id === value ? 0 : -1}
      onClick={() => select(item.id)} onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        const next = event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1)
          : offset ? items[(index + offset + items.length) % items.length] : null;
        if (next) { event.preventDefault(); select(next.id); }
      }} className={`rounded px-3 py-2 text-sm ${item.id === value ? 'bg-primary/15 text-primary' : 'hover:bg-muted'}`}>{item.title}</button>)}
  </div>;
}
