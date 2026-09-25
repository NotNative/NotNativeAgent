// SPDX-License-Identifier: Apache-2.0
/** Manual, sandboxed preview. Agent inspection and capture are not exposed here. */
import { useState, type FormEvent, type ReactNode } from 'react';
import { normalizePreviewUrl } from '../lib/browser/preview-url.ts';

export function BrowserSurface(): ReactNode {
  const [address, setAddress] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [reload, setReload] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const active = index >= 0 ? history[index] ?? null : null;

  function navigate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const target = normalizePreviewUrl(address, window.location.origin);
    if (!target) { setInvalid(true); return; }
    setInvalid(false);
    setAddress(target);
    if (target === active) { setReload((value) => value + 1); return; }
    setHistory((items) => [...items.slice(0, index + 1), target]);
    setIndex(index + 1);
  }

  function move(delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= history.length) return;
    setIndex(next);
    setAddress(history[next]!);
    setInvalid(false);
  }

  return <section className="flex h-full min-h-0 flex-col" data-testid="operator-browser">
    <header className="border-b border-white/10 p-2">
      <h2 className="mb-2 text-xs font-medium text-neutral-200">Browser preview</h2>
      <form onSubmit={navigate} className="flex gap-1">
        <input aria-label="Preview address" value={address} onChange={(event) => { setAddress(event.target.value); setInvalid(false); }}
          placeholder="localhost:5173" spellCheck={false} className="min-w-0 flex-1 rounded border border-white/15 bg-neutral-900 px-2 py-1 text-xs text-neutral-100" />
        <button type="submit" className="rounded border border-white/15 px-2 text-xs text-neutral-200">Go</button>
      </form>
      {invalid ? <p role="alert" className="mt-1 text-[11px] text-amber-300">Enter an HTTP(S) address outside this app. Credentials in URLs are not allowed.</p> : null}
      <div className="mt-2 flex items-center gap-1 text-[11px] text-neutral-300">
        <button type="button" aria-label="Preview back" disabled={index <= 0} onClick={() => move(-1)} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">←</button>
        <button type="button" aria-label="Preview forward" disabled={index < 0 || index >= history.length - 1} onClick={() => move(1)} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">→</button>
        <button type="button" aria-label="Reload preview" disabled={!active} onClick={() => setReload((value) => value + 1)} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">Reload</button>
        {active ? <a href={active} target="_blank" rel="noopener noreferrer" className="ml-auto rounded border border-white/15 px-2 py-0.5">Open externally</a> : null}
      </div>
    </header>
    {active ? <iframe key={`${active}|${reload}`} title="Sandboxed browser preview" src={active}
      sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-white" /> :
      <p className="p-3 text-[11px] text-neutral-500">Enter a local dev-server or website address to preview it. This isolated web preview cannot inspect, annotate, or capture the page. Sites that prohibit embedding may not display.</p>}
  </section>;
}
