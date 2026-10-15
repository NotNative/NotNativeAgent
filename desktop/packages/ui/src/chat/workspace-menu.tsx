// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { useWorkspaceDisplayStore } from '../stores/useWorkspaceDisplayStore.ts';

export function WorkspaceMenu({ id, label, hidden }: { id: string; label: string; hidden: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: { label: string; hidden: boolean }) => {
    setBusy(true); setError(null);
    try { await useWorkspaceDisplayStore.getState().save(id, value); setEditing(false); return true; }
    catch { setError('Could not save this workspace. Try again.'); toast.error('Could not save this workspace. Try again.'); return false; }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-white/10" onClick={event => {
      const details = event.currentTarget.closest('details'); if (details) details.open = false;
      setName(label); setEditing(true);
    }}>Rename workspace</button>
    <button type="button" disabled={busy} className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-white/10" onClick={event => {
      const details = event.currentTarget.closest('details'); if (details) details.open = false;
      void save({ label, hidden: !hidden }).then(saved => {
        if (saved) toast.message(hidden ? 'Workspace shown' : 'Workspace removed from sidebar. Files and conversations are preserved.');
      });
    }}>{hidden ? 'Show workspace' : 'Remove from sidebar'}</button>
    {error && !editing ? <p role="alert" className="px-3 text-xs text-red-300">{error}</p> : null}
    {editing ? createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form role="dialog" aria-modal="true" aria-label="Rename workspace" className="w-full max-w-md rounded-xl border border-white/15 bg-neutral-900 p-5"
        onSubmit={event => { event.preventDefault(); if (name.trim()) void save({ label: name.trim(), hidden }); }}
        onKeyDown={event => { if (event.key === 'Escape' && !busy) setEditing(false); }}>
        <h2 className="mb-3">Rename workspace</h2>
        <input aria-label="Workspace name" autoFocus maxLength={120} value={name} onChange={event => setName(event.target.value)} className="w-full rounded bg-neutral-800 px-3 py-2" />
        {error ? <p role="alert" className="mt-2 text-red-300">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-4"><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          <button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</button></div>
      </form>
    </div>, document.body) : null}
  </>;
}
