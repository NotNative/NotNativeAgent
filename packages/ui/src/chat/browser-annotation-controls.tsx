// SPDX-License-Identifier: Apache-2.0
/** Human-only page annotation. Renderer shield keeps selection clicks out of the guest. */
import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { annotationScript, formatAnnotationDraft,
  parsePageAnnotation, type PageAnnotation } from '../lib/browser/page-annotation.ts';
import { captureAnnotationImage, type AnnotationGuest } from '../lib/browser/annotation-capture.ts';
import { formatRegionDraft, parsePageRegion, regionScript, type RegionAnnotation } from '../lib/browser/region-annotation.ts';
import { formatStrokeDraft, parsePageStrokes, strokeScript, type StrokeAnnotation } from '../lib/browser/stroke-annotation.ts';

type Guest = AnnotationGuest;
type Selection = PageAnnotation | RegionAnnotation | StrokeAnnotation;
type Point = { x: number; y: number };
type Drag = { id: number; start: Point; end: Point; rect: { left: number; top: number; width: number; height: number } };
type StrokeDrag = { id: number; points: Point[]; rect: Drag['rect'] };

export function BrowserAnnotationControls({ guest, currentUrl, revision, shieldTarget, blocked, onActive }: {
  guest: () => Guest | null; currentUrl: () => string | null; revision: () => number;
  shieldTarget: HTMLElement | null; blocked: () => boolean; onActive: (active: boolean) => void;
}): ReactNode {
  const [selecting, setSelecting] = useState(false);
  const [mode, setMode] = useState<'element' | 'region' | 'stroke'>('element');
  const [selected, setSelected] = useState<Selection | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [strokePreview, setStrokePreview] = useState<Point[]>([]);
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
  const activeStroke = useRef<StrokeDrag | null>(null);
  const strokeList = useRef<Point[][]>([]);
  const strokeFrame = useRef<Drag['rect'] | null>(null);
  const url = currentUrl();

  function cancel(): void {
    run.current += 1;
    selectingGuest.current = null;
    selectionBusy.current = false;
    activeDrag.current = null; setDrag(null);
    activeStroke.current = null; setStrokePreview([]);
    strokeList.current = []; strokeFrame.current = null; setStrokes([]);
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
      const stroke = activeStroke.current;
      if (stroke && shieldRef.current?.hasPointerCapture?.(stroke.id))
        shieldRef.current.releasePointerCapture?.(stroke.id);
      activeStroke.current = null; setStrokePreview([]);
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('blur', blur);
    };
  }, [selecting]);

  function toggle(nextMode: 'element' | 'region' | 'stroke'): void {
    if (selectingGuest.current) { cancel(); return; }
    const target = guest();
    const pageUrl = currentUrl();
    if (!target?.executeJavaScript || !pageUrl || target.getURL?.() !== pageUrl || !shieldTarget || blocked()) return;
    setSelected(null);
    selectionId.current = '';
    selectedGuest.current = null;
    setComment('');
    setError(null);
    strokeList.current = []; strokeFrame.current = null; setStrokes([]); setStrokePreview([]);
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

  function startStroke(event: PointerEvent<HTMLDivElement>): void {
    if (mode !== 'stroke') return;
    event.preventDefault(); event.stopPropagation();
    if (event.button !== 0 || activeStroke.current || selectionBusy.current) return;
    if (strokeList.current.length >= 8) { setError('At most eight strokes can be marked.'); return; }
    const start = point(event);
    if (!start) return;
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const frame = strokeFrame.current;
    if (frame && (Math.abs(left - frame.left) > 1 || Math.abs(top - frame.top) > 1
      || Math.abs(width - frame.width) > 1 || Math.abs(height - frame.height) > 1)) {
      strokeList.current = []; strokeFrame.current = null; setStrokes([]);
      setError('The page viewport moved during annotation. Draw again.'); return;
    }
    strokeFrame.current = { left, top, width, height };
    activeStroke.current = { id: event.pointerId, points: [start], rect: { left, top, width, height } };
    setStrokePreview([start]); setError(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function moveStroke(event: PointerEvent<HTMLDivElement>): void {
    if (mode !== 'stroke') return;
    event.preventDefault(); event.stopPropagation();
    const active = activeStroke.current; const next = point(event);
    if (!active || active.id !== event.pointerId || !next || active.points.length >= 128) return;
    const last = active.points[active.points.length - 1]!;
    if (Math.hypot((next.x - last.x) * active.rect.width, (next.y - last.y) * active.rect.height) < 2) return;
    active.points.push(next); setStrokePreview([...active.points]);
  }

  function finishStroke(event: PointerEvent<HTMLDivElement>): void {
    if (mode !== 'stroke') return;
    event.preventDefault(); event.stopPropagation();
    const active = activeStroke.current;
    if (!active || active.id !== event.pointerId) return;
    activeStroke.current = null; setStrokePreview([]);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    if (Math.abs(rect.left - active.rect.left) > 1 || Math.abs(rect.top - active.rect.top) > 1
      || Math.abs(rect.width - active.rect.width) > 1 || Math.abs(rect.height - active.rect.height) > 1) {
      setError('The page viewport moved during annotation. Draw again.'); return;
    }
    const end = point(event);
    if (end && active.points.length < 128) active.points.push(end);
    const length = active.points.slice(1).reduce((distance, current, index) =>
      distance + Math.hypot((current.x - active.points[index]!.x) * rect.width,
        (current.y - active.points[index]!.y) * rect.height), 0);
    if (length < 8) { setError('Draw a stroke at least 8 pixels long.'); return; }
    strokeList.current = [...strokeList.current, active.points]; setStrokes(strokeList.current);
  }

  async function confirmStrokes(): Promise<void> {
    if (mode !== 'stroke' || activeStroke.current || selectionBusy.current || !strokeList.current.length) return;
    const rect = shieldRef.current?.getBoundingClientRect(); const frame = strokeFrame.current;
    if (!rect || !frame || Math.abs(rect.left - frame.left) > 1 || Math.abs(rect.top - frame.top) > 1
      || Math.abs(rect.width - frame.width) > 1 || Math.abs(rect.height - frame.height) > 1) {
      strokeList.current = []; strokeFrame.current = null; setStrokes([]);
      setError('The page viewport moved during annotation. Draw again.'); return;
    }
    const target = selectingGuest.current; const pageUrl = currentUrl();
    if (!target?.executeJavaScript || guest() !== target || target.getURL?.() !== pageUrl
      || revision() !== selectionRevision.current || !pageUrl) {
      cancel(); setError('The page changed during annotation. Draw again.'); return;
    }
    selectionBusy.current = true; const token = run.current;
    try {
      const value = await target.executeJavaScript(strokeScript(pageUrl,
        strokeList.current.map((stroke) => stroke.map((point) => [point.x, point.y]))), false);
      if (token !== run.current) return;
      if (guest() !== target || currentUrl() !== pageUrl || target.getURL?.() !== pageUrl
        || revision() !== selectionRevision.current) throw new Error('The page changed during annotation.');
      const parsed = parsePageStrokes(value);
      if (!parsed || parsed.url !== pageUrl) throw new Error('No verifiable strokes were selected. Draw again.');
      selectedGuest.current = target; selectionId.current = crypto.randomUUID();
      setSelected(parsed); cancel();
    } catch (cause) {
      if (token === run.current) setError(cause instanceof Error ? cause.message.slice(0, 200) : 'Annotation failed.');
    } finally { if (token === run.current) selectionBusy.current = false; }
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
          ? annotation.kind === 'stroke' ? formatStrokeDraft(annotation, message) : formatRegionDraft(annotation, message)
          : formatAnnotationDraft(annotation, message), attachment,
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
    <button type="button" onClick={() => toggle('stroke')}
      disabled={!selecting && (blocked() || !shieldTarget || !guest()?.executeJavaScript || guest()?.getURL?.() !== url)}
      aria-pressed={selecting && mode === 'stroke'} className="ml-2 rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">
      {selecting && mode === 'stroke' ? 'Cancel drawing' : 'Draw on page'}
    </button>
    {selecting && mode === 'stroke' && strokes.length ? <button type="button" onClick={() => { void confirmStrokes(); }}
      className="ml-2 rounded border border-sky-500/50 px-2 py-0.5">Use drawing ({strokes.length}/8)</button> : null}
    {selecting ? <span role="status" className="ml-2">{mode === 'region'
      ? 'Drag a page region; Escape cancels.' : mode === 'stroke'
        ? 'Draw up to eight strokes, then use drawing; Escape cancels.'
        : 'Click a visible page element; Escape cancels.'}</span> : null}
    {selecting && shieldTarget ? createPortal(<div ref={shieldRef} tabIndex={0}
      data-testid="browser-annotation-shield" aria-label={`Select a page ${mode}; Escape cancels`}
      className="absolute inset-0 z-50 cursor-crosshair touch-none bg-sky-300/5 outline-none"
      onClick={(event) => { void choose(event); }} onPointerDown={(event) => { startRegion(event); startStroke(event); }}
      onPointerMove={(event) => { moveRegion(event); moveStroke(event); }}
      onPointerUp={(event) => { void finishRegion(event); finishStroke(event); }}
      onPointerCancel={(event) => { event.preventDefault(); event.stopPropagation();
        if (activeDrag.current?.id === event.pointerId) { activeDrag.current = null; setDrag(null); }
        if (activeStroke.current?.id === event.pointerId) { activeStroke.current = null; setStrokePreview([]); }
      }}
      onLostPointerCapture={(event) => {
        if (activeDrag.current?.id === event.pointerId) { activeDrag.current = null; setDrag(null); }
        if (activeStroke.current?.id === event.pointerId) { activeStroke.current = null; setStrokePreview([]); }
      }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={(event) => event.preventDefault()}>
      {drag ? <div data-testid="browser-annotation-region" className="pointer-events-none absolute border-2 border-sky-400 bg-sky-400/20"
        style={{ left: `${Math.min(drag.start.x, drag.end.x) * 100}%`, top: `${Math.min(drag.start.y, drag.end.y) * 100}%`,
          width: `${Math.abs(drag.start.x - drag.end.x) * 100}%`, height: `${Math.abs(drag.start.y - drag.end.y) * 100}%` }} /> : null}
      {mode === 'stroke' ? <svg data-testid="browser-annotation-strokes" className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
        {[...strokes, strokePreview].filter((stroke) => stroke.length > 1).map((stroke, index) =>
          <polyline key={index} points={stroke.map((item) => `${item.x * 1000},${item.y * 1000}`).join(' ')}
            fill="none" stroke="#0ea5e9" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />)}
      </svg> : null}
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg">
        {mode === 'region' ? 'Drag to mark a region' : mode === 'stroke' ? 'Draw freehand strokes' : 'Click to mark an element'} · Escape cancels
      </div>
    </div>, shieldTarget) : null}
    {selected ? <div className="mt-2 space-y-1 rounded border border-sky-500/30 p-2" data-testid="browser-annotation-draft">
      <p className="truncate">{'kind' in selected ? selected.kind === 'stroke' ? 'Selected page drawing' : 'Selected page region'
        : `Selected ${selected.tag} · ${selected.label || selected.selector}`}</p>
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
