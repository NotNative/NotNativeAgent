// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';

export function WorkspacePathDialog({ path, busy, onPathChange, onSubmit, onClose }: {
  path: string;
  busy: boolean;
  onPathChange: (path: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}): ReactNode {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form role="dialog" aria-modal="true" aria-label="Add workspace by path" className="w-full max-w-md rounded-2xl border border-white/15 bg-neutral-900 p-5 shadow-2xl" onSubmit={event => { event.preventDefault(); if (path.trim()) onSubmit(); }}>
      <h2 className="text-base font-semibold text-neutral-100">Add workspace</h2>
      <p className="mt-1 text-xs text-neutral-400">Enter the absolute folder path on this computer.</p>
      <input aria-label="Workspace folder path" autoFocus value={path} onChange={event => onPathChange(event.target.value)} placeholder="D:\\Projects\\MyWorkspace" className="mt-4 w-full rounded-lg border border-white/15 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-sky-500" />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" disabled={busy} className="rounded-lg px-3 py-2 text-xs text-neutral-300 hover:bg-white/10" onClick={onClose}>Cancel</button>
        <button type="submit" disabled={busy || !path.trim()} className="rounded-lg bg-sky-500 px-3 py-2 text-xs font-medium text-neutral-950 hover:bg-sky-400 disabled:opacity-40">Add workspace</button>
      </div>
    </form>
  </div>;
}
