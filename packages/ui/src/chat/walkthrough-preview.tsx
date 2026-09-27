// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { loadWalkthroughPreview, type WalkthroughPreview } from '../lib/git/walkthrough-preview.ts';

export function WalkthroughPreviewSurface({ directory, visible }: { directory: string; visible: boolean }): ReactNode {
  const [record, setRecord] = useState<{ directory: string; preview: WalkthroughPreview } | null>(null);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const preview = record?.directory === directory ? record.preview : null;
  const capture = useCallback(async (): Promise<void> => {
    const id = ++request.current;
    setLoading(true); setError(null);
    try {
      const next = await loadWalkthroughPreview(directory);
      if (id !== request.current) return;
      setRecord({ directory, preview: next }); setActive(0); setStale(false);
    } catch (cause) {
      if (id === request.current) {
        setStale(true);
        setError(cause instanceof Error ? cause.message : 'Could not load walkthrough preview.');
      }
    }
    finally { if (id === request.current) setLoading(false); }
  }, [directory]);
  useEffect(() => {
    if (!visible) return;
    void capture();
    return () => { request.current += 1; };
  }, [visible, capture]);
  useEffect(() => {
    if (!visible || !preview || stale) return;
    let live = true;
    let checking = false;
    const check = (): void => {
      if (document.hidden || checking) return;
      checking = true;
      void loadWalkthroughPreview(directory).then((current) => {
        if (live && current.signature !== preview.signature) setStale(true);
      }).catch(() => { if (live) { setStale(true); setError('Could not verify whether this preview is current. Refresh before relying on it.'); } })
        .finally(() => { checking = false; });
    };
    const timer = window.setInterval(check, 15_000);
    window.addEventListener('focus', check);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', check); };
  }, [directory, preview, stale, visible]);
  const stop = preview?.stops[active];
  return <section className="flex h-full min-h-0 flex-col" data-testid="walkthrough-preview">
    <header className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
      <div className="min-w-0 flex-1 text-xs font-medium text-neutral-200">Diff walkthrough</div>
      <button type="button" className="rounded border border-white/15 px-2 py-1 text-[11px] text-neutral-300" disabled={loading} onClick={() => void capture()}>Refresh</button>
    </header>
    <div className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">
      Deterministic preview · actual local Git hunks in patch order. No AI explanation or remote send.
    </div>
    {stale && preview ? <div role="status" className="border-b border-amber-500/30 px-3 py-2 text-xs text-amber-300">{error ? 'The current changes could not be verified against this preview. Refresh before relying on it.' : 'Changes moved since this preview was captured. Refresh to rebuild the stops.'}</div> : null}
    {error ? <div role="alert" className="border-b border-amber-500/30 px-3 py-2 text-xs text-amber-300">{error}</div> : null}
    {loading && !preview ? <p role="status" className="p-3 text-xs text-neutral-400">Loading current diff…</p> : null}
    {preview && preview.stops.length === 0 ? <p className="p-3 text-xs text-neutral-400">No text hunks to walk through. Binary-only changes are not rendered in this preview.</p> : null}
    {preview && preview.binaryFiles > 0 ? <p className="border-b border-white/10 px-3 py-2 text-[11px] text-neutral-400">{preview.binaryFiles} binary file scope(s) are omitted from hunk navigation.</p> : null}
    {preview && stop ? <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <button type="button" aria-label="Previous hunk" disabled={active === 0} onClick={() => setActive(active - 1)}>←</button>
        <span data-testid="walkthrough-position">{active + 1} / {preview.stops.length}</span>
        <button type="button" aria-label="Next hunk" disabled={active + 1 >= preview.stops.length} onClick={() => setActive(active + 1)}>→</button>
      </div>
      <nav aria-label="Diff hunk stops" className="max-h-40 overflow-y-auto border-b border-white/10 p-2">
        {preview.stops.map((item, index) => <button key={item.id} type="button" aria-current={index === active ? 'step' : undefined}
          className={`block w-full truncate rounded px-2 py-1 text-left text-[11px] ${index === active ? 'bg-white/10 text-white' : 'text-neutral-400 hover:text-white'}`}
          onClick={() => setActive(index)}>{index + 1}. {item.scope} · {item.path}:{item.newStart}</button>)}
      </nav>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <div className="sticky top-0 bg-neutral-950 py-1 text-xs text-neutral-200">{stop.scope} · {stop.path} · old:{stop.oldStart} new:{stop.newStart}</div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-neutral-300" data-testid="walkthrough-hunk">{stop.header}{'\n'}{stop.body}</pre>
      </div>
    </div> : null}
  </section>;
}
