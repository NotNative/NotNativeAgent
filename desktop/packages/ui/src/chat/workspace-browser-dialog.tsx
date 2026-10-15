// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { runtimeFetch } from '../lib/runtime-fetch.ts';
type Listing = { path: string; parent: string; home: string; roots: string[];
  entries: { name: string; path: string }[]; truncated: boolean };

export function WorkspaceBrowserDialog({ busy, onPick, onClose }: {
  busy: boolean; onPick: (path: string) => void; onClose: () => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const read = useRef(0);
  const navigate = async (target = '') => {
    const revision = ++read.current;
    setLoading(true); setError(null);
    try {
      const response = await runtimeFetch(`/api/workspace-browser?path=${encodeURIComponent(target)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not open this folder.');
      if (revision === read.current) { setListing(data); setPath(data.path); }
    } catch (failure) { if (revision === read.current) setError(String(failure)); }
    finally { if (revision === read.current) setLoading(false); }
  };
  useEffect(() => { void navigate(); return () => { read.current += 1; }; }, []);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <section role="dialog" aria-modal="true" aria-label="Choose workspace folder" className="w-full max-w-xl rounded-xl border border-white/15 bg-neutral-900 p-5 text-sm text-neutral-200"
      onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
      <h2 className="mb-3 text-base font-medium">Choose workspace folder</h2>
      <form className="mb-3 flex gap-2" onSubmit={event => { event.preventDefault(); void navigate(path); }}>
        <input aria-label="Folder location" autoFocus value={path} onChange={event => setPath(event.target.value)} className="min-w-0 flex-1 rounded border border-white/15 bg-neutral-800 px-3 py-2" />
        <button type="submit" disabled={busy}>Go</button>
      </form>
      <div className="mb-2 flex flex-wrap gap-3">
        <button disabled={busy || loading} onClick={() => void navigate(listing?.parent)}>Up</button>
        <button disabled={busy || loading} onClick={() => void navigate(listing?.home)}>Home</button>
        {listing?.roots.map(root => <button disabled={busy || loading} key={root} onClick={() => void navigate(root)}>{root}</button>)}
      </div>
      <div className="h-64 overflow-auto rounded border border-white/10 p-1" aria-busy={loading}>
        {loading ? <p role="status" className="p-3">Loading folders…</p> : null}
        {!loading ? listing?.entries.map(entry => <button key={entry.path} type="button" disabled={busy} className="block w-full rounded px-3 py-2 text-left hover:bg-white/10" onClick={() => void navigate(entry.path)}>▱ {entry.name}</button>) : null}
        {!loading && listing?.entries.length === 0 ? <p className="p-3 text-neutral-400">No subfolders. You can select this folder.</p> : null}
      </div>
      {listing?.truncated ? <p role="status" className="mt-2 text-xs">Folder list limited. Enter a folder location above to navigate directly.</p> : null}
      {error ? <p role="alert" className="mt-2 text-red-300">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-4">
        <button disabled={busy} onClick={onClose}>Cancel</button>
        <button disabled={busy || loading || !listing || !!error} className="rounded bg-sky-600 px-3 py-2 disabled:opacity-40" onClick={() => listing && onPick(listing.path)}>{busy ? 'Adding workspace…' : 'Select folder'}</button>
      </div>
    </section>
  </div>;
}
