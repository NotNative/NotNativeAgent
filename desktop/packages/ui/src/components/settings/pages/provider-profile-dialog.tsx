// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, type ReactNode } from 'react';

/** Native dialog owns focus, Escape, and the inert background in both web and Electron. */
export function ProviderProfileDialog({ title, busy, onClose, children }: {
  title: string; busy: boolean; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => { if (typeof dialog.close === 'function') dialog.close(); };
  }, []);
  return <dialog ref={ref} aria-label={title} className="m-auto max-h-[85vh] w-[min(640px,90vw)] overflow-auto rounded-xl border border-border/60 bg-card p-5 text-foreground shadow-2xl backdrop:bg-black/60"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}
    onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
    <div className="mb-4 flex items-center justify-between"><h3 className="text-base font-semibold">{title}</h3>
      <button type="button" aria-label="Close provider editor" disabled={busy} onClick={onClose}>✕</button></div>
    <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">{children}</fieldset>
  </dialog>;
}
