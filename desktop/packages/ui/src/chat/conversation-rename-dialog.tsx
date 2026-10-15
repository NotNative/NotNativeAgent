// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { createPortal } from 'react-dom';

export function ConversationRenameDialog({ title, save, close }: { title: string; save: (title: string) => Promise<void>; close: () => void }) {
  const [name, setName] = useState(title); const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  return createPortal(<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <form role="dialog" aria-modal="true" aria-label="Rename conversation" className="w-full max-w-md rounded-xl border border-white/15 bg-neutral-900 p-5"
      onKeyDown={event => { if (event.key === 'Escape' && !busy) close(); }}
      onSubmit={event => { event.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError(false); void save(name.trim()).then(close).catch(() => setError(true)).finally(() => setBusy(false)); }}>
      <h2 className="mb-3">Rename conversation</h2>
      <input aria-label="Conversation name" autoFocus maxLength={120} value={name} onChange={event => setName(event.target.value)} className="w-full rounded bg-neutral-800 px-3 py-2" />
      {error ? <p role="alert" className="mt-2 text-red-300">Could not rename this conversation. Try again.</p> : null}
      <div className="mt-4 flex justify-end gap-4"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</button></div>
    </form>
  </div>, document.body);
}
