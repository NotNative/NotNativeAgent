// SPDX-License-Identifier: Apache-2.0
/** Human-only page annotation. Renderer shield keeps selection clicks out of the guest. */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { annotationScript, formatAnnotationDraft,
  parsePageAnnotation, type PageAnnotation } from '../lib/browser/page-annotation.ts';
import { captureAnnotationImage, type AnnotationGuest } from '../lib/browser/annotation-capture.ts';
import { formatRegionDraft, parsePageRegion, regionScript, type RegionAnnotation } from '../lib/browser/region-annotation.ts';

type Guest = AnnotationGuest;
type Selection = PageAnnotation | RegionAnnotation;
type Point = { x: number; y: number };
type Drag = { id: number; start: Point; end: Point; rect: { left: number; top: number; width: number; height: number } };

export function BrowserAnnotationControls({ guest, currentUrl, revision, shieldTarget, blocked, onActive }: {
  guest: () => Guest | null; currentUrl: () => string | null; revision: () => number;
  shieldTarget: HTMLElement | null; blocked: () => boolean; onActive: (active: boolean) => void;
}): ReactNode {
  const [selecting, setSelecting] = useState(false);
  const [mode, setMode] = useState<'element' | 'region'>('element');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const run = useRef(0);
  const selectingGuest = useRef<Guest | null>(null);
  const selectedGuest = useRef<Guest | null>(null);
  const selectionRevision = useRef(0);
  const selectionBusy = useRef(false);
  const selectionId = useRef('');
  const shieldRef = useRef<HTMLDivElement | null>(null);
  const activeDrag = useRef<Drag | null>(null);
  const url = currentUrl();

  function cancel(): void {
    run.current += 1;
    selectingGuest.current = null;
    selectionBusy.current = false;
    activeDrag.current = null; setDrag(null);
    onActive(false);
    setSelecting(false);
  }

  useEffect(() => {
    selectedGuest.current = null;
    setSelected(null); setComment(''); setError(null); setSelecting(false);
    return () => {
      run.current += 1;
      selectingGuest.current = null;
      selectionBusy.current = false;
      onActive(false);
    };
  }, [url]);

  useEffect(() => {
    if (!selecting) return;
    shieldRef.current?.focus();
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); event.stopImmediatePropagation(); cancel();
      }
    };
    const blur = (): void => {
      const active = activeDrag.current;
      if (active && shieldRef.current?.hasPointerCapture?.(active.id))
        shieldRef.current.releasePointerCapture?.(active.id);
      activeDrag.current = null;
      setDrag(null);
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', blur);
    };
  }, [selecting]);

  function toggle(nextMode: 'element' | 'region'): void {
    if (selectingGuest.current) { cancel(); return; }
    const target = guest();
    const pageUrl = currentUrl();
    if (!target?.executeJavaScript || !pageUrl || target.getURL?.() !== pageUrl || !shieldTarget || blocked()) return;
    setSelected(null);
    selectionId.current = '';
    selectedGuest.current = null;
    setComment('');
    setError(null);
    setMode(nextMode);
    selectingGuest.current = target;
    onActive(true);
    selectionRevision.current = revision();
    run.current += 1;
    setSelecting(true);
  }

  async function choose(event: MouseEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault(); event.stopPropagation();
    if (mode !== 'element' || selectionBusy.current) return;
    const target = selectingGuest.current;
    const pageUrl = currentUrl();
    if (!target?.executeJavaScript || guest() !== target || target.getURL?.() !== pageUrl
      || revision() !== selectionRevision.current || !pageUrl) {
      cancel(); setError('The page changed during annotation. Select the element again.'); return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    selectionBusy.current = true;
    const token = run.current;
    try {
      const value = await target.executeJavaScript(annotationScript(pageUrl, x, y), false);
      if (token !== run.current) return;
      if (guest() !== target || currentUrl() !== pageUrl || target.getURL?.() !== pageUrl
        || revision() !== selectionRevision.current) throw new Error('The page changed during annotation.');
      const parsed = parsePageAnnotation(value);
      if (!parsed || parsed.url !== pageUrl) throw new Error('No verifiable element was selected. Try another point.');
      selectedGuest.current = target;
      selectionId.current = crypto.randomUUID();
      setSelected(parsed);
      cancel();
    } catch (cause) {
      if (token === run.current) setError(cause instanceof Error ? cause.message.slice(0, 200) : 'Annotation failed.');
    } finally {
      if (token === run.current) selectionBusy.current = false;
    }
  }

  function point(event: PointerEvent<HTMLDivElement>): Point | null {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }

  function startRegion(event: PointerEvent<HTMLDivElement>): void {
    if (mode !== 'region' || event.button !== 0 || activeDrag.current || selectionBusy.current) return;
    event.preventDefault(); event.stopPropagation();
    const start = point(event);
    if (!start) return;
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    activeDrag.current = { id: event.pointerId, start, end: start, rect: { left, top, width, height } };
    setDrag(activeDrag.current);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveRegion(event: PointerEvent<HTMLDivElement>): void {
    if (mode !== 'region') return;
    event.preventDefault(); event.stopPropagation();
    const active = activeDrag.current;
    if (!active || active.id !== event.pointerId) return;
    const end = point(event);
    if (end) { activeDrag.current = { ...active, end }; setDrag(activeDrag.current); }
  }

  async function finishRegion(event: PointerEvent<HTMLDivElement>): Promise<void> {
    if (mode !== 'region') return;
    event.preventDefault(); event.stopPropagation();
    const active = activeDrag.current;
    if (!active || active.id !== event.pointerId) return;
    activeDrag.current = null; setDrag(null);
    const rect = event.currentTarget.getBoundingClientRect();
    if (Math.abs(rect.left - active.rect.left) > 1 || Math.abs(rect.top - active.rect.top) > 1
      || Math.abs(rect.width - active.rect.width) > 1 || Math.abs(rect.height - active.rect.height) > 1) {
      setError('The page viewport moved during annotation. Draw the region again.'); return;
    }
    const end = point(event);
    if (!end || selectionBusy.current) return;
    const target = selectingGuest.current;
    const pageUrl = currentUrl();
    if (!target?.executeJavaScript || guest() !== target || target.getURL?.() !== pageUrl
      || revision() !== selectionRevision.current || !pageUrl) {
      cancel(); setError('The page changed during annotation. Select the region again.'); return;
    }
    const fractions: [number, number, number, number] = [Math.min(active.start.x, end.x), Math.min(active.start.y, end.y),
      Math.max(active.start.x, end.x), Math.max(active.start.y, end.y)];
    if ((fractions[2] - fractions[0]) * rect.width < 8
      || (fractions[3] - fractions[1]) * rect.height < 8) {
      setError('Draw a region at least 8 × 8 pixels.'); return;
    }
    selectionBusy.current = true;
    const token = run.current;
    try {
      const value = await target.executeJavaScript(regionScript(pageUrl, fractions), false);
      if (token !== run.current) return;
      if (guest() !== target || currentUrl() !== pageUrl || target.getURL?.() !== pageUrl
        || revision() !== selectionRevision.current) throw new Error('The page changed during annotation.');
      const parsed = parsePageRegion(value);
      if (!parsed || parsed.url !== pageUrl) throw new Error('No verifiable region was selected. Try again.');
      selectedGuest.current = target; selectionId.current = crypto.randomUUID();
      setSelected(parsed); cancel();
    } catch (cause) {
      if (token === run.current) setError(cause instanceof Error ? cause.message.slice(0, 200) : 'Annotation failed.');
    } finally { if (token === run.current) selectionBusy.current = false; }
  }

  async function addToComposer(): Promise<void> {
    if (!selected || !comment.trim() || selected.url !== currentUrl() || guest() !== selectedGuest.current
      || revision() !== selectionRevision.current || blocked() || attaching
      || guest()?.getURL?.() !== selected.url) {
      setError('The page changed, or a comment is missing. Select the mark again.');
      return;
    }
    const target = selectedGuest.current!;
    const annotation = selected;
    const message = comment;
    let targetKey = '';
    window.dispatchEvent(new CustomEvent('nnd:composer-annotation-target', { detail: {
      accept: (key: string) => { targetKey = key; },
    } }));
    if (!targetKey) { setError('Open a chat draft before adding this annotation.'); return; }
    onActive(true);
    selectionRevision.current = revision();
    const token = ++run.current;
    setAttaching(true); setError(null);
    const stillCurrent = (): boolean => token === run.current && guest() === target
      && currentUrl() === annotation.url && target.getURL?.() === annotation.url
      && revision() === selectionRevision.current;
    try {
      const attachment = await captureAnnotationImage(target, annotation, stillCurrent);
      if (!stillCurrent()) throw new Error('The page changed during screenshot capture. Select the element again.');
      let accepted = false;
      window.dispatchEvent(new CustomEvent('nnd:composer-annotation', { detail: {
        id: selectionId.current, targetKey, text: 'kind' in annotation
          ? formatRegionDraft(annotation, message) : formatAnnotationDraft(annotation, message), attachment,
        accept: () => { accepted = true; },
      } }));
      if (!accepted) throw new Error('Open a chat draft before adding this annotation.');
      setSelected(null); selectedGuest.current = null; setComment('');
    } catch (cause) {
      if (token === run.current) setError(cause instanceof Error ? cause.message.slice(0, 200) : 'Screenshot attachment failed.');
    } finally {
      if (token === run.current) { setAttaching(false); onActive(false); }
    }
  }

  return <div className="mt-2 text-[11px] text-neutral-300" data-testid="browser-annotation-controls">
    <button type="button" onClick={() => toggle('element')}
      disabled={!selecting && (blocked() || !shieldTarget || !guest()?.executeJavaScript || guest()?.getURL?.() !== url)}
      aria-pressed={selecting && mode === 'element'} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">
      {selecting && mode === 'element' ? 'Cancel annotation' : 'Annotate element'}
    </button>
    <button type="button" onClick={() => toggle('region')}
      disabled={!selecting && (blocked() || !shieldTarget || !guest()?.executeJavaScript || guest()?.getURL?.() !== url)}
      aria-pressed={selecting && mode === 'region'} className="ml-2 rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">
      {selecting && mode === 'region' ? 'Cancel region' : 'Annotate region'}
    </button>
    {selecting ? <span role="status" className="ml-2">{mode === 'region'
      ? 'Drag a page region; Escape cancels.' : 'Click a visible page element; Escape cancels.'}</span> : null}
    {selecting && shieldTarget ? createPortal(<div ref={shieldRef} tabIndex={0}
      data-testid="browser-annotation-shield" aria-label={`Select a page ${mode}; Escape cancels`}
      className="absolute inset-0 z-50 cursor-crosshair bg-sky-300/5 outline-none"
      onClick={(event) => { void choose(event); }} onPointerDown={startRegion} onPointerMove={moveRegion}
      onPointerUp={(event) => { void finishRegion(event); }}
      onPointerCancel={() => { activeDrag.current = null; setDrag(null); }}
      onLostPointerCapture={() => { activeDrag.current = null; setDrag(null); }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={(event) => event.preventDefault()}>
      {drag ? <div data-testid="browser-annotation-region" className="pointer-events-none absolute border-2 border-sky-400 bg-sky-400/20"
        style={{ left: `${Math.min(drag.start.x, drag.end.x) * 100}%`, top: `${Math.min(drag.start.y, drag.end.y) * 100}%`,
          width: `${Math.abs(drag.start.x - drag.end.x) * 100}%`, height: `${Math.abs(drag.start.y - drag.end.y) * 100}%` }} /> : null}
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg">
        {mode === 'region' ? 'Drag to mark a region' : 'Click to mark an element'} · Escape cancels
      </div>
    </div>, shieldTarget) : null}
    {selected ? <div className="mt-2 space-y-1 rounded border border-sky-500/30 p-2" data-testid="browser-annotation-draft">
      <p className="truncate">{'kind' in selected ? 'Selected page region' : `Selected ${selected.tag} · ${selected.label || selected.selector}`}</p>
      <label htmlFor="browser-annotation-comment">Comment</label>
      <textarea id="browser-annotation-comment" value={comment} maxLength={2000}
        onChange={(event) => setComment(event.target.value)} rows={2}
        className="block w-full resize-y rounded border border-white/15 bg-neutral-900 p-1 text-neutral-100" />
      <button type="button" onClick={() => { void addToComposer(); }} disabled={!comment.trim() || attaching}
        className="rounded border border-sky-500/50 px-2 py-0.5 disabled:opacity-35">{attaching ? 'Capturing…' : 'Add to chat draft'}</button>
      <button type="button" disabled={attaching} onClick={() => { setSelected(null); setComment(''); }} className="ml-2 underline disabled:opacity-35">Discard</button>
      <p className="text-neutral-500">Adds a highlighted viewport screenshot and mark details to the draft; nothing is sent automatically.</p>
    </div> : null}
    {error ? <p role="alert" className="mt-1 text-amber-300">{error}</p> : null}
  </div>;
}
