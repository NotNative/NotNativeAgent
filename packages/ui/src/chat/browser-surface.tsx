// SPDX-License-Identifier: Apache-2.0
/** Manual, sandboxed preview. Agent inspection and capture are not exposed here. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { normalizePreviewUrl } from '../lib/browser/preview-url.ts';

interface DiscoveredServer { port: number; url: string; command: string }
type Discovery = { kind: 'loading' | 'unavailable'; servers: [] }
  | { kind: 'ready'; servers: DiscoveredServer[] };
type Readiness = { key: string; state: 'checking' | 'ready' | 'timed-out' | 'unavailable' };

function isLoopbackPreview(value: string | null): boolean {
  if (!value) return false;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname.toLowerCase()); }
  catch { return false; }
}

function usePreviewReadiness(active: string | null, reload: number, visible: boolean, localRuntime: boolean): Readiness | null {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const key = `${active ?? ''}|${reload}`;
  useEffect(() => {
    if (!active || !visible || !localRuntime || !isLoopbackPreview(active)) {
      setReadiness(null);
      return;
    }
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const started = Date.now();
    const deadlineTimer = setTimeout(() => {
      closed = true;
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      setReadiness({ key, state: 'timed-out' });
    }, 30_000);
    setReadiness({ key, state: 'checking' });
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch('/api/system/probe-url', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: active }), signal: controller.signal });
        if (!response.ok) throw new Error('probe unavailable');
        const result = await response.json() as { ok?: unknown; status?: unknown };
        if (closed) return;
        if (result.ok === true) {
          if (!Number.isInteger(result.status) || (result.status as number) < 200
            || (result.status as number) >= 600) throw new Error('invalid probe response');
          if ((result.status as number) < 500 || Date.now() - started >= 20_000) {
            clearTimeout(deadlineTimer);
            setReadiness({ key, state: 'ready' });
            return;
          }
        } else if (result.ok !== false) throw new Error('invalid probe response');
      } catch {
        if (closed) return;
        clearTimeout(deadlineTimer);
        setReadiness({ key, state: 'unavailable' });
        return;
      }
      retryTimer = setTimeout(() => { void probe(); }, 2000);
    };
    void probe();
    return () => {
      closed = true;
      controller.abort();
      clearTimeout(deadlineTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [active, key, localRuntime, visible]);
  return readiness;
}

export function canPreviewDiscoveredServers(appOrigin: string): boolean {
  try {
    const host = new URL(appOrigin).hostname.toLowerCase().replace(/\.$/u, '');
    return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(host);
  } catch { return false; }
}

function validServers(value: unknown): DiscoveredServer[] | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { servers?: unknown }).servers)) return null;
  const servers = (value as { servers: unknown[] }).servers;
  return servers.every((item) => item && typeof item === 'object'
    && Number.isInteger((item as DiscoveredServer).port)
    && (item as DiscoveredServer).port > 0 && (item as DiscoveredServer).port <= 65535
    && (item as DiscoveredServer).url === `http://localhost:${(item as DiscoveredServer).port}/`
    && typeof (item as DiscoveredServer).command === 'string')
    ? servers as DiscoveredServer[] : null;
}

export function BrowserSurface({ visible = true }: { visible?: boolean } = {}): ReactNode {
  const localRuntime = canPreviewDiscoveredServers(window.location.origin);
  const [address, setAddress] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const [reload, setReload] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>({ kind: 'loading', servers: [] });
  const [scanRevision, setScanRevision] = useState(0);
  const active = index >= 0 ? history[index] ?? null : null;
  const readiness = usePreviewReadiness(active, reload, visible, localRuntime);
  const probeKey = `${active ?? ''}|${reload}`;
  const waitForLocal = localRuntime && isLoopbackPreview(active);
  const probeState = readiness?.key === probeKey ? readiness.state : 'checking';

  useEffect(() => {
    if (!visible || active || !localRuntime) return;
    const interval = window.setInterval(() => setScanRevision((value) => value + 1), 2000);
    return () => window.clearInterval(interval);
  }, [visible, active, localRuntime]);

  useEffect(() => {
    if (!visible || active || !localRuntime) return;
    const controller = new AbortController();
    setDiscovery((current) => current.kind === 'ready' ? current : { kind: 'loading', servers: [] });
    void fetch('/api/dev-servers', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('discovery unavailable');
      const servers = validServers(await response.json());
      if (!servers) throw new Error('invalid discovery response');
      if (!controller.signal.aborted) setDiscovery({ kind: 'ready', servers });
    }).catch(() => {
      if (!controller.signal.aborted) setDiscovery({ kind: 'unavailable', servers: [] });
    });
    return () => controller.abort();
  }, [scanRevision, visible, active, localRuntime]);

  function open(target: string): void {
    setInvalid(false);
    setAddress(target);
    if (target === active) { setReload((value) => value + 1); return; }
    setHistory((items) => [...items.slice(0, index + 1), target]);
    setIndex(index + 1);
  }

  function navigate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const target = normalizePreviewUrl(address, window.location.origin);
    if (!target) { setInvalid(true); return; }
    open(target);
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
    {active && waitForLocal && probeState !== 'ready' ? <div className="p-3 text-xs text-neutral-400" role="status">
      {probeState === 'checking' ? 'Waiting for local server to start…' : probeState === 'timed-out'
        ? 'Local server did not answer within 30 seconds.' : 'Readiness check unavailable.'}
      {probeState !== 'checking' ? <button type="button" className="ml-2 underline" onClick={() => setReload((value) => value + 1)}>Retry</button> : null}
    </div> : null}
    {active && visible && (!waitForLocal || probeState === 'ready') ? <iframe key={`${active}|${reload}`} title="Sandboxed browser preview" src={active}
      sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer"
      className="min-h-0 w-full flex-1 border-0 bg-white" /> : !active ?
      <div className="p-3 text-[11px] text-neutral-500">
        <p>Enter a local dev-server or website address to preview it. This isolated web preview cannot inspect, annotate, or capture the page. Sites that prohibit embedding may not display.</p>
        <div className="mt-3 flex items-center gap-2"><span className="text-neutral-300">Listening dev servers</span>
          {localRuntime ? <button type="button" onClick={() => setScanRevision((value) => value + 1)} className="underline">Refresh</button> : null}</div>
        {!localRuntime ? <p role="status">Server discovery is available only when this browser runs on the server machine. Enter a reachable address manually.</p> : null}
        {localRuntime && discovery.kind === 'loading' ? <p role="status">Scanning local ports…</p> : null}
        {localRuntime && discovery.kind === 'unavailable' ? <p role="status">Discovery unavailable; enter an address manually.</p> : null}
        {localRuntime && discovery.kind === 'ready' && discovery.servers.length === 0 ? <p role="status">No local dev servers found.</p> : null}
        {localRuntime && discovery.kind === 'ready' ? <ul>{discovery.servers.map((server) => <li key={server.port}>
          <button type="button" className="py-1 text-sky-300 underline" onClick={() => open(server.url)}>
            {server.url}{server.command ? ` · ${server.command}` : ''}</button>
        </li>)}</ul> : null}
      </div> : null}
  </section>;
}
