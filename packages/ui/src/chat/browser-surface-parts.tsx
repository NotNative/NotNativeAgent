// SPDX-License-Identifier: Apache-2.0
/** Stateless sub-surfaces of BrowserSurface: inspection readout and the discovery empty state. */
import type { ReactNode } from 'react';
import type { PageSnapshot } from '../lib/browser/page-snapshot.ts';

export interface DiscoveredServer { port: number; url: string; command: string }
export type Discovery = { kind: 'loading' | 'unavailable'; servers: [] }
  | { kind: 'ready'; servers: DiscoveredServer[] };

/** Inspection readout for the last inspect/click/type cycle. */
export function InspectionPanel({ snapshot, onClose }: { snapshot: PageSnapshot; onClose: () => void }): ReactNode {
  return <div className="max-h-56 overflow-auto border-b border-white/10 p-2 text-[11px] text-neutral-300" data-testid="browser-page-snapshot">
    <div className="flex justify-between"><strong>{snapshot.title || snapshot.url}</strong><button type="button" className="underline" onClick={onClose}>Close inspection</button></div>
    <p className="mt-1 break-all text-neutral-500">{snapshot.url}</p>
    <p className="mt-1">{snapshot.text}{snapshot.textTruncated ? '…' : ''}</p>
    <p className="mt-2 text-neutral-500">{snapshot.interactiveElementsOnPage} interactive elements{snapshot.elementsTruncated ? ' (first 120 shown)' : ''}</p>
    <ul>{snapshot.elements.map((element, idx) => <li key={`${element.selector}-${idx}`} className="truncate">{element.tag} · {element.label || '(unlabeled)'} · {element.selector}</li>)}</ul>
  </div>;
}

/** Blank-page state: manual entry plus the local dev-server discovery list. */
export function PreviewEmptyState({ desktop, localRuntime, discovery, onScan, onOpen }: {
  desktop: boolean; localRuntime: boolean; discovery: Discovery;
  onScan: () => void; onOpen: (url: string) => void;
}): ReactNode {
  return <div className="p-3 text-[11px] text-neutral-500">
    <p>{desktop ? 'Enter a local dev-server or HTTPS site to open in an isolated desktop browser. Governed agent inspection and viewport capture require an open page; annotation remains pending.' : 'Enter a local dev-server or website address to preview it. Loopback dev servers load through the same-origin preview proxy, so governed inspection and DOM capture work here without Electron. Other sites that prohibit embedding may not display.'}</p>
    <div className="mt-3 flex items-center gap-2"><span className="text-neutral-300">Listening dev servers</span>
      {localRuntime ? <button type="button" onClick={onScan} className="underline">Refresh</button> : null}</div>
    {!localRuntime ? <p role="status">Server discovery is available only when this browser runs on the server machine. Enter a reachable address manually.</p> : null}
    {localRuntime && discovery.kind === 'loading' ? <p role="status">Scanning local ports…</p> : null}
    {localRuntime && discovery.kind === 'unavailable' ? <p role="status">Discovery unavailable; enter an address manually.</p> : null}
    {localRuntime && discovery.kind === 'ready' && discovery.servers.length === 0 ? <p role="status">No local dev servers found.</p> : null}
    {localRuntime && discovery.kind === 'ready' ? <ul>{discovery.servers.map((server) => <li key={server.port}>
      <button type="button" className="py-1 text-sky-300 underline" onClick={() => onOpen(server.url)}>{server.url}{server.command ? ` · ${server.command}` : ''}</button></li>)}</ul> : null}
  </div>;
}
