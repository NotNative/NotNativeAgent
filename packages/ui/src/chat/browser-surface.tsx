// SPDX-License-Identifier: Apache-2.0
/** Manual, isolated preview with user-triggered read-only DOM inspection. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { normalizePreviewUrl, isLoopbackPreview, canEmbedDesktopPreview } from '../lib/browser/preview-url.ts';
import { runtimeFetch } from '../lib/runtime-fetch.ts';
export { canEmbedDesktopPreview } from '../lib/browser/preview-url.ts';
import { pageSnapshotScript, parsePageSnapshot, type PageSnapshot } from '../lib/browser/page-snapshot.ts';
import { pageInspectionScript, parsePageInspection } from '../lib/browser/page-inspection.ts';
import { pageClickScript, parsePageClick } from '../lib/browser/page-click.ts';
import { pageScrollScript, parsePageScroll, type ScrollDirection } from '../lib/browser/page-scroll.ts';
import { executeDesktopType } from '../lib/browser/desktop-type-action.ts';
import { executeDesktopCapture } from '../lib/browser/desktop-capture-action.ts';
import { executeDesktopHistory, historyNavigationPending as historyPendingNow, type HistoryPending } from '../lib/browser/desktop-history-action.ts';
import { BrowserAnnotationControls } from './browser-annotation-controls.tsx';
import { usePreviewReadiness } from '../lib/browser/preview-readiness.ts';
import { isDesktopShell } from '../lib/platform.ts';

interface DiscoveredServer { port: number; url: string; command: string }
type Discovery = { kind: 'loading' | 'unavailable'; servers: [] }
  | { kind: 'ready'; servers: DiscoveredServer[] };
type GuestStatus = { kind: 'loading' | 'ready' | 'failed'; message: string };
type ControlRequest = { requestId: string; action: string; parameters: Record<string, unknown> };

function guestEventValue(event: Event, name: string): unknown {
  const payload = event as Event & Record<string, unknown> & { detail?: Record<string, unknown> };
  return payload[name] ?? payload.detail?.[name];
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
  const desktop = isDesktopShell();
  const [address, setAddress] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const historyRef = useRef(history);
  const indexRef = useRef(index);
  const guestRef = useRef<HTMLElement | null>(null);
  const [annotationShieldTarget, setAnnotationShieldTarget] = useState<HTMLDivElement | null>(null);
  const [guestStart, setGuestStart] = useState<string | null>(null);
  const [guestStatus, setGuestStatus] = useState<GuestStatus | null>(null);
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const inspectionRevision = useRef(0);
  const observationId = useRef<string | null>(null);
  const clickScriptPending = useRef<Promise<unknown> | null>(null);
  const scrollScriptPending = useRef<Promise<unknown> | null>(null);
  const typeScriptPending = useRef<Promise<unknown> | null>(null);
  const capturePending = useRef<Promise<unknown> | null>(null);
  const annotationActive = useRef(false);
  const historyPending = useRef<HistoryPending | null>(null);
  const controlHandler = useRef<(request: ControlRequest) => Promise<void>>(async () => undefined);
  const controlGeneration = useRef(0);
  const [reload, setReload] = useState(0);
  const [invalid, setInvalid] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery>({ kind: 'loading', servers: [] });
  const [scanRevision, setScanRevision] = useState(0);
  const active = index >= 0 ? history[index] ?? null : null;
  historyRef.current = history;
  indexRef.current = index;
  // An in-page guest navigation must not remount the guest or restart the
  // startup probe. Only an explicit toolbar command changes guestStart.
  const readinessTarget = desktop ? guestStart : active;
  const readiness = usePreviewReadiness(readinessTarget, reload, visible, localRuntime);
  const probeKey = `${readinessTarget ?? ''}|${reload}`;
  const waitForLocal = localRuntime && isLoopbackPreview(readinessTarget);
  const probeState = readiness?.key === probeKey ? readiness.state : 'checking';

  function invalidateInspection(): void {
    inspectionRevision.current += 1;
    observationId.current = null;
    setSnapshot(null);
    setSnapshotError(null);
    setSnapshotBusy(false);
  }

  function historyNavigationPending(): boolean {
    return historyPendingNow(historyPending, guestRef.current, historyRef.current[indexRef.current]);
  }

  function otherActionPending(): boolean {
    return Boolean(historyNavigationPending() || clickScriptPending.current || scrollScriptPending.current
      || typeScriptPending.current || capturePending.current);
  }

  useEffect(() => {
    if (!visible) invalidateInspection();
  }, [visible]);

  useEffect(() => () => { inspectionRevision.current += 1; }, []);

  useEffect(() => {
    // Hiding destroys the guest. Preserve its latest top-level URL so a later
    // reveal restores the page actually shown, not the original launch URL.
    if (desktop && !visible && active && guestStart !== active) setGuestStart(active);
  }, [active, desktop, guestStart, visible]);

  useEffect(() => {
    const guest = guestRef.current;
    if (!desktop || !visible || !guest || (waitForLocal && probeState !== 'ready')) return;
    const navigation = (event: Event): void => {
      if (historyPending.current?.fromGuest === guest) return;
      const url = guestEventValue(event, 'url');
      if (typeof url !== 'string' || !canEmbedDesktopPreview(url)) return;
      const target = normalizePreviewUrl(url, window.location.origin);
      if (!target) return;
      invalidateInspection();
      setGuestStatus({ kind: 'ready', message: target });
      if (target === historyRef.current[indexRef.current]) return;
      const next = [...historyRef.current.slice(0, indexRef.current + 1), target];
      historyRef.current = next;
      indexRef.current = next.length - 1;
      setHistory(next);
      setIndex(next.length - 1);
      setAddress(target);
    };
    const loading = (): void => {
      invalidateInspection();
      setGuestStatus({ kind: 'loading', message: 'Loading page…' });
    };
    const failure = (event: Event): void => {
      if (guestEventValue(event, 'isMainFrame') === false || guestEventValue(event, 'errorCode') === -3) return;
      const description = guestEventValue(event, 'errorDescription');
      setGuestStatus({ kind: 'failed', message: typeof description === 'string' ? description : 'Page failed to load.' });
    };
    const crashed = (): void => {
      invalidateInspection();
      setGuestStatus({ kind: 'failed', message: 'Preview renderer stopped. Reload to retry.' });
    };
    const stopped = (): void => {
      // History remounts the guest. An old guest finishing a prior load cannot
      // authorize the next snapshot; only the replacement guest can do that.
      if (historyPending.current && guestRef.current === guest
        && historyPending.current.fromGuest !== guest) historyNavigationPending();
    };
    guest.addEventListener('did-navigate', navigation);
    guest.addEventListener('did-navigate-in-page', navigation);
    guest.addEventListener('did-start-loading', loading);
    guest.addEventListener('did-fail-load', failure);
    guest.addEventListener('render-process-gone', crashed);
    guest.addEventListener('did-stop-loading', stopped);
    return () => {
      guest.removeEventListener('did-navigate', navigation);
      guest.removeEventListener('did-navigate-in-page', navigation);
      guest.removeEventListener('did-start-loading', loading);
      guest.removeEventListener('did-fail-load', failure);
      guest.removeEventListener('render-process-gone', crashed);
      guest.removeEventListener('did-stop-loading', stopped);
    };
  }, [desktop, guestStart, probeState, reload, visible, waitForLocal]);

  useEffect(() => {
    if (!visible || active || !localRuntime) return;
    const interval = window.setInterval(() => setScanRevision((value) => value + 1), 2000);
    return () => window.clearInterval(interval);
  }, [visible, active, localRuntime]);

  useEffect(() => {
    if (!visible || active || !localRuntime) return;
    const controller = new AbortController();
    setDiscovery((current) => current.kind === 'ready' ? current : { kind: 'loading', servers: [] });
    void runtimeFetch('/api/dev-servers', { signal: controller.signal }).then(async (response) => {
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
    historyPending.current = null;
    setInvalid(false);
    setAddress(target);
    setGuestStart(target);
    setGuestStatus(null);
    invalidateInspection();
    if (target === active) { setReload((value) => value + 1); return; }
    const next = [...historyRef.current.slice(0, indexRef.current + 1), target];
    historyRef.current = next;
    indexRef.current = next.length - 1;
    setHistory(next);
    setIndex(next.length - 1);
  }

  function navigate(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const target = normalizePreviewUrl(address, window.location.origin);
    if (!target || (desktop && !canEmbedDesktopPreview(target))) { setInvalid(true); return; }
    open(target);
  }

  function move(delta: number): void {
    const next = indexRef.current + delta;
    if (next < 0 || next >= historyRef.current.length) return;
    const target = historyRef.current[next]!;
    indexRef.current = next;
    setIndex(next);
    setAddress(target);
    setGuestStart(target);
    if (guestStart === target) setReload((value) => value + 1);
    setGuestStatus(null);
    invalidateInspection();
    setInvalid(false);
  }

  async function inspectPage(): Promise<void> {
    const guest = guestRef.current as (HTMLElement & {
      executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
    }) | null;
    if (!desktop || !guest?.executeJavaScript || snapshotBusy || otherActionPending() || annotationActive.current) return;
    const revision = ++inspectionRevision.current;
    setSnapshotBusy(true);
    setSnapshotError(null);
    setSnapshot(null);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const value = await Promise.race([guest.executeJavaScript(pageSnapshotScript(), false),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Page inspection timed out.')), 15_000);
        })]);
      const result = parsePageSnapshot(value);
      if (revision !== inspectionRevision.current) return;
      if (!result || guestRef.current !== guest || result.url !== historyRef.current[indexRef.current])
        throw new Error('The page changed before inspection finished.');
      setSnapshot(result);
    } catch (error) {
      if (revision === inspectionRevision.current)
        setSnapshotError(error instanceof Error ? error.message : 'Page inspection failed.');
    } finally {
      if (timeout) clearTimeout(timeout);
      if (revision === inspectionRevision.current) setSnapshotBusy(false);
    }
  }

  async function handleControlRequest(request: ControlRequest): Promise<void> {
    const face = window.__NOTNATIVE_BROWSER_CONTROL__;
    if (!face || !/^browser-[0-9a-f-]{36}$/u.test(request.requestId)) return;
    const generation = controlGeneration.current;
    const claim = await face.claim(request.requestId);
    if (!claim.ok || claim.result?.granted !== true) return;
    if (generation !== controlGeneration.current) return;
    let result: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      if (request.action === 'browser.open') {
        if (annotationActive.current) throw new Error('Finish page annotation before another browser action.');
        const value = request.parameters?.url;
        const target = typeof value === 'string' ? normalizePreviewUrl(value, window.location.origin) : null;
        if (!target || !canEmbedDesktopPreview(target)) throw new Error('The requested preview URL is not allowed.');
        open(target);
        result = { ok: true, data: { url: target, opened: true, settled: false } };
      } else if (request.action === 'browser.snapshot') {
        if (otherActionPending() || annotationActive.current)
          throw new Error('A prior browser action is still running; wait before taking a new snapshot.');
        const guest = guestRef.current as (HTMLElement & {
          executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
        }) | null;
        if (!guest?.executeJavaScript) throw new Error('Open a page in the desktop Browser pane first.');
        const revision = inspectionRevision.current;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let value: unknown;
        try {
          value = await Promise.race([guest.executeJavaScript(pageSnapshotScript(), false),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error('Page inspection timed out.')), 15_000);
            })]);
        } finally { if (timeout) clearTimeout(timeout); }
        const snapshot = parsePageSnapshot(value);
        if (!snapshot || guestRef.current !== guest || revision !== inspectionRevision.current
          || snapshot.url !== historyRef.current[indexRef.current]) throw new Error('The page changed before the snapshot completed.');
        observationId.current = crypto.randomUUID();
        result = { ok: true, data: { ...snapshot, observationRevision: revision, observationId: observationId.current } };
      } else if (request.action === 'browser.inspect') {
        const selector = request.parameters?.selector;
        if (typeof selector !== 'string' || !selector || selector.length > 500) throw new Error('A bounded CSS selector is required.');
        const guest = guestRef.current as (HTMLElement & {
          executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
        }) | null;
        if (!guest?.executeJavaScript) throw new Error('Open a page in the desktop Browser pane first.');
        if (otherActionPending() || annotationActive.current)
          throw new Error('A prior browser action is still running; wait before inspecting.');
        const revision = inspectionRevision.current;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let value: unknown;
        try {
          value = await Promise.race([guest.executeJavaScript(pageInspectionScript(selector), false),
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Page inspection timed out.')), 15_000); })]);
        } finally { if (timeout) clearTimeout(timeout); }
        if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string')
          throw new Error(value.error.slice(0, 200));
        const inspection = parsePageInspection(value, selector);
        if (!inspection || guestRef.current !== guest || revision !== inspectionRevision.current
          || inspection.url !== historyRef.current[indexRef.current]) throw new Error('The page changed before inspection completed.');
        result = { ok: true, data: inspection };
      } else if (request.action === 'browser.click') {
        const { selector, expectedUrl, observationRevision, observationId: expectedObservationId } = request.parameters ?? {};
        if (typeof selector !== 'string' || !selector || selector.length > 500
          || typeof expectedUrl !== 'string' || !expectedUrl || expectedUrl.length > 2048
          || !Number.isSafeInteger(observationRevision) || (observationRevision as number) < 0
          || typeof expectedObservationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(expectedObservationId))
          throw new Error('A bounded selector and observed URL are required.');
        const guest = guestRef.current as (HTMLElement & {
          executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
        }) | null;
        if (!guest?.executeJavaScript || historyRef.current[indexRef.current] !== expectedUrl
          || inspectionRevision.current !== observationRevision || observationId.current !== expectedObservationId)
          throw new Error('The page changed; take a new snapshot before clicking.');
        if (otherActionPending() || annotationActive.current)
          throw new Error('A prior browser action may still complete; wait before retrying.');
        invalidateInspection();
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let value: unknown;
        try {
          const execution = guest.executeJavaScript(pageClickScript(selector, expectedUrl), true);
          clickScriptPending.current = execution;
          void execution.then(() => { if (clickScriptPending.current === execution) clickScriptPending.current = null; },
            () => { if (clickScriptPending.current === execution) clickScriptPending.current = null; });
          value = await Promise.race([execution,
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Click result timed out; inspect the page before retrying.')), 15_000); })]);
        } finally { if (timeout) clearTimeout(timeout); }
        if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string')
          throw new Error(value.error.slice(0, 200));
        const clicked = parsePageClick(value, selector, expectedUrl);
        if (!clicked) throw new Error('Click outcome is uncertain; inspect the page before retrying.');
        result = { ok: true, data: clicked };
      } else if (request.action === 'browser.scroll') {
        const { direction, expectedUrl, observationRevision, observationId: expectedObservationId } = request.parameters ?? {};
        if (!['up', 'down', 'top', 'bottom'].includes(String(direction))
          || typeof expectedUrl !== 'string' || !expectedUrl || expectedUrl.length > 2048
          || !Number.isSafeInteger(observationRevision) || (observationRevision as number) < 0
          || typeof expectedObservationId !== 'string' || !/^[0-9a-f-]{36}$/u.test(expectedObservationId))
          throw new Error('A direction and observed URL are required.');
        const guest = guestRef.current as (HTMLElement & {
          executeJavaScript?: (script: string, userGesture?: boolean) => Promise<unknown>;
        }) | null;
        if (!guest?.executeJavaScript || historyRef.current[indexRef.current] !== expectedUrl
          || inspectionRevision.current !== observationRevision || observationId.current !== expectedObservationId)
          throw new Error('The page changed; take a new snapshot before scrolling.');
        if (otherActionPending() || annotationActive.current)
          throw new Error('A prior browser action may still complete; wait before scrolling.');
        invalidateInspection();
        const revision = inspectionRevision.current;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        let value: unknown;
        try {
          const execution = guest.executeJavaScript(pageScrollScript(direction as ScrollDirection, expectedUrl), false);
          scrollScriptPending.current = execution;
          void execution.then(() => { if (scrollScriptPending.current === execution) scrollScriptPending.current = null; },
            () => { if (scrollScriptPending.current === execution) scrollScriptPending.current = null; });
          value = await Promise.race([execution,
            new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Scroll result timed out; inspect the page before retrying.')), 15_000); })]);
        } finally { if (timeout) clearTimeout(timeout); }
        if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string')
          throw new Error(value.error.slice(0, 200));
        const scrolled = parsePageScroll(value, direction as ScrollDirection, expectedUrl);
        if (!scrolled || guestRef.current !== guest || revision !== inspectionRevision.current
          || historyRef.current[indexRef.current] !== expectedUrl)
          throw new Error('Scroll outcome is uncertain; inspect the page before retrying.');
        result = { ok: true, data: scrolled };
      } else if (request.action === 'browser.history') {
        result = { ok: true, data: executeDesktopHistory(request.parameters ?? {}, {
          guest: guestRef.current, history: historyRef.current, index: indexRef.current,
          revision: inspectionRevision.current, observationId: observationId.current, pending: historyPending,
          otherPending: () => Boolean(annotationActive.current || clickScriptPending.current || scrollScriptPending.current
            || typeScriptPending.current || capturePending.current), move,
        }) };
      } else if (request.action === 'browser.type') {
        const typed = await executeDesktopType(request.parameters ?? {}, {
          guest: guestRef.current, currentGuest: () => guestRef.current,
          currentUrl: () => historyRef.current[indexRef.current], revision: () => inspectionRevision.current,
          observationId: () => observationId.current,
          otherPending: () => Boolean(annotationActive.current || historyNavigationPending() || clickScriptPending.current || scrollScriptPending.current || capturePending.current),
          pending: typeScriptPending, invalidate: invalidateInspection,
        });
        result = { ok: true, data: typed };
      } else if (request.action === 'browser.capture') {
        const captured = await executeDesktopCapture(request.parameters ?? {}, {
          guest: guestRef.current, currentGuest: () => guestRef.current, currentUrl: () => historyRef.current[indexRef.current],
          revision: () => inspectionRevision.current, observationId: () => observationId.current,
          otherPending: () => Boolean(annotationActive.current || historyNavigationPending() || clickScriptPending.current || scrollScriptPending.current || typeScriptPending.current), pending: capturePending, invalidate: invalidateInspection,
        });
        result = { ok: true, data: captured };
      } else throw new Error(`${request.action} is not available in this build.`);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1000) : 'Browser action failed.';
      result = { ok: false, error: request.action === 'browser.type'
        && message !== 'Type result timed out; inspect the page before retrying.'
        ? 'Type action failed or its outcome is uncertain; inspect the page before retrying.' : message };
    }
    if (generation !== controlGeneration.current) return;
    const posted = await face.result(request.requestId, result);
    if (!posted.ok) console.warn('Browser control result could not be delivered:', posted.error);
  }
  controlHandler.current = handleControlRequest;

  useEffect(() => {
    const face = window.__NOTNATIVE_BROWSER_CONTROL__;
    if (!desktop || !visible || !face) return;
    controlGeneration.current += 1;
    let closed = false;
    const unsubscribe = face.onRequest((request) => { if (!closed) void controlHandler.current(request); });
    void face.register().then((answer) => {
      if (!answer.ok && !closed) console.warn('Desktop browser control registration failed:', answer.error);
    });
    return () => {
      closed = true;
      controlGeneration.current += 1;
      unsubscribe();
      void face.unregister();
    };
  }, [desktop, visible]);

  return <section className="flex h-full min-h-0 flex-col" data-testid="operator-browser">
    <header className="border-b border-white/10 p-2">
      <h2 className="mb-2 text-xs font-medium text-neutral-200">Browser preview</h2>
      <form onSubmit={navigate} className="flex gap-1">
        <input aria-label="Preview address" value={address} onChange={(event) => { setAddress(event.target.value); setInvalid(false); }}
          placeholder="localhost:5173" spellCheck={false} className="min-w-0 flex-1 rounded border border-white/15 bg-neutral-900 px-2 py-1 text-xs text-neutral-100" />
        <button type="submit" className="rounded border border-white/15 px-2 text-xs text-neutral-200">Go</button>
      </form>
      {invalid ? <p role="alert" className="mt-1 text-[11px] text-amber-300">Enter an HTTP(S) address outside this app. Desktop preview requires HTTPS or loopback HTTP; credentials are not allowed.</p> : null}
      <div className="mt-2 flex items-center gap-1 text-[11px] text-neutral-300">
        <button type="button" aria-label="Preview back" disabled={index <= 0} onClick={() => move(-1)} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">←</button>
        <button type="button" aria-label="Preview forward" disabled={index < 0 || index >= history.length - 1} onClick={() => move(1)} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">→</button>
        <button type="button" aria-label="Reload preview" disabled={!active} onClick={() => { setGuestStart(active); setGuestStatus(null); invalidateInspection(); setReload((value) => value + 1); }} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">Reload</button>
        {desktop ? <button type="button" disabled={!active || snapshotBusy} onClick={() => { void inspectPage(); }}
          className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">{snapshotBusy ? 'Inspecting…' : 'Inspect page'}</button> : null}
        {active ? <a href={active} target="_blank" rel="noopener noreferrer" className="ml-auto rounded border border-white/15 px-2 py-0.5">Open externally</a> : null}
      </div>
      {desktop && active && visible ? <BrowserAnnotationControls key={`${guestStart}|${reload}|${active}`} guest={() => guestRef.current}
        currentUrl={() => historyRef.current[indexRef.current] ?? null}
        revision={() => inspectionRevision.current} shieldTarget={annotationShieldTarget}
        blocked={() => otherActionPending() || snapshotBusy}
        onActive={(value) => { annotationActive.current = value; if (value) invalidateInspection(); }} /> : null}
      {desktop && guestStatus ? <p role="status" className={`mt-1 text-[11px] ${guestStatus.kind === 'failed' ? 'text-amber-300' : 'text-neutral-400'}`}>{guestStatus.message}</p> : null}
      {snapshotError ? <p role="alert" className="mt-1 text-[11px] text-amber-300">{snapshotError}</p> : null}
    </header>
    {snapshot ? <div className="max-h-56 overflow-auto border-b border-white/10 p-2 text-[11px] text-neutral-300" data-testid="browser-page-snapshot">
      <div className="flex justify-between"><strong>{snapshot.title || snapshot.url}</strong><button type="button" className="underline" onClick={() => setSnapshot(null)}>Close inspection</button></div>
      <p className="mt-1 break-all text-neutral-500">{snapshot.url}</p>
      <p className="mt-1">{snapshot.text}{snapshot.textTruncated ? '…' : ''}</p>
      <p className="mt-2 text-neutral-500">{snapshot.interactiveElementsOnPage} interactive elements{snapshot.elementsTruncated ? ' (first 120 shown)' : ''}</p>
      <ul>{snapshot.elements.map((element, idx) => <li key={`${element.selector}-${idx}`} className="truncate">{element.tag} · {element.label || '(unlabeled)'} · {element.selector}</li>)}</ul>
    </div> : null}
    {active && waitForLocal && probeState !== 'ready' ? <div className="p-3 text-xs text-neutral-400" role="status">
      {probeState === 'checking' ? 'Waiting for local server to start…' : probeState === 'timed-out'
        ? 'Local server did not answer within 30 seconds.' : 'Readiness check unavailable.'}
      {probeState !== 'checking' ? <button type="button" className="ml-2 underline" onClick={() => setReload((value) => value + 1)}>Retry</button> : null}
    </div> : null}
    {active && visible && (!waitForLocal || probeState === 'ready') ? desktop
      ? <div className="relative min-h-0 flex-1" ref={setAnnotationShieldTarget}>
        <webview key={`${guestStart}|${reload}`} ref={(node) => { guestRef.current = node; }} title="Isolated desktop browser preview" src={guestStart ?? active} partition="nnd-preview" className="h-full w-full border-0 bg-white" />
      </div>
      : <iframe key={`${active}|${reload}`} title="Sandboxed browser preview" src={active} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" /> : !active ?
      <div className="p-3 text-[11px] text-neutral-500">
        <p>{desktop ? 'Enter a local dev-server or HTTPS site to open in an isolated desktop browser. Governed agent inspection and viewport capture require an open page; annotation remains pending.' : 'Enter a local dev-server or website address to preview it. This isolated web preview cannot inspect, annotate, or capture the page. Sites that prohibit embedding may not display.'}</p>
        <div className="mt-3 flex items-center gap-2"><span className="text-neutral-300">Listening dev servers</span>
          {localRuntime ? <button type="button" onClick={() => setScanRevision((value) => value + 1)} className="underline">Refresh</button> : null}</div>
        {!localRuntime ? <p role="status">Server discovery is available only when this browser runs on the server machine. Enter a reachable address manually.</p> : null}
        {localRuntime && discovery.kind === 'loading' ? <p role="status">Scanning local ports…</p> : null}
        {localRuntime && discovery.kind === 'unavailable' ? <p role="status">Discovery unavailable; enter an address manually.</p> : null}
        {localRuntime && discovery.kind === 'ready' && discovery.servers.length === 0 ? <p role="status">No local dev servers found.</p> : null}
        {localRuntime && discovery.kind === 'ready' ? <ul>{discovery.servers.map((server) => <li key={server.port}>
          <button type="button" className="py-1 text-sky-300 underline" onClick={() => open(server.url)}>{server.url}{server.command ? ` · ${server.command}` : ''}</button></li>)}</ul> : null}
      </div> : null}
  </section>;
}
