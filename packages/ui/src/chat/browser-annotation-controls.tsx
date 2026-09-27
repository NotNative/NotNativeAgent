// SPDX-License-Identifier: Apache-2.0
/** Human-only page annotation. Renderer shield keeps selection clicks out of the guest. */
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { annotationScript, formatAnnotationDraft,
  parsePageAnnotation, type PageAnnotation } from '../lib/browser/page-annotation.ts';
import { captureAnnotationImage, type AnnotationGuest } from '../lib/browser/annotation-capture.ts';

type Guest = AnnotationGuest;

export function BrowserAnnotationControls({ guest, currentUrl, revision, shieldTarget, blocked, onActive }: {
  guest: () => Guest | null; currentUrl: () => string | null; revision: () => number;
  shieldTarget: HTMLElement | null; blocked: () => boolean; onActive: (active: boolean) => void;
}): ReactNode {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<PageAnnotation | null>(null);
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
  const url = currentUrl();

  function cancel(): void {
    run.current += 1;
    selectingGuest.current = null;
    selectionBusy.current = false;
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
    window.addEventListener('keydown', keydown, true);
    return () => window.removeEventListener('keydown', keydown, true);
  }, [selecting]);

  function toggle(): void {
    if (selectingGuest.current) { cancel(); return; }
    const target = guest();
    const pageUrl = currentUrl();
    if (!target?.executeJavaScript || !pageUrl || target.getURL?.() !== pageUrl || !shieldTarget || blocked()) return;
    setSelected(null);
    selectionId.current = '';
    selectedGuest.current = null;
    setComment('');
    setError(null);
    selectingGuest.current = target;
    onActive(true);
    selectionRevision.current = revision();
    run.current += 1;
    setSelecting(true);
  }

  async function choose(event: MouseEvent<HTMLDivElement>): Promise<void> {
    event.preventDefault(); event.stopPropagation();
    if (selectionBusy.current) return;
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

  async function addToComposer(): Promise<void> {
    if (!selected || !comment.trim() || selected.url !== currentUrl() || guest() !== selectedGuest.current
      || revision() !== selectionRevision.current || blocked() || attaching
      || guest()?.getURL?.() !== selected.url) {
      setError('The page changed, or a comment is missing. Select the element again.');
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
        id: selectionId.current, targetKey, text: formatAnnotationDraft(annotation, message), attachment,
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
    <button type="button" onClick={toggle}
      disabled={!selecting && (blocked() || !shieldTarget || !guest()?.executeJavaScript || guest()?.getURL?.() !== url)}
      aria-pressed={selecting} className="rounded border border-white/15 px-2 py-0.5 disabled:opacity-35">
      {selecting ? 'Cancel annotation' : 'Annotate element'}
    </button>
    {selecting ? <span role="status" className="ml-2">Click a visible page element; Escape cancels.</span> : null}
    {selecting && shieldTarget ? createPortal(<div ref={shieldRef} tabIndex={0}
      data-testid="browser-annotation-shield" aria-label="Select a page element; Escape cancels"
      className="absolute inset-0 z-50 cursor-crosshair bg-sky-300/5 outline-none"
      onClick={(event) => { void choose(event); }} onContextMenu={(event) => event.preventDefault()}
      onWheel={(event) => event.preventDefault()}>
      <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded bg-neutral-900 px-3 py-2 text-xs text-white shadow-lg">
        Click to mark an element · Escape cancels
      </div>
    </div>, shieldTarget) : null}
    {selected ? <div className="mt-2 space-y-1 rounded border border-sky-500/30 p-2" data-testid="browser-annotation-draft">
      <p className="truncate">Selected {selected.tag} · {selected.label || selected.selector}</p>
      <label htmlFor="browser-annotation-comment">Comment</label>
      <textarea id="browser-annotation-comment" value={comment} maxLength={2000}
        onChange={(event) => setComment(event.target.value)} rows={2}
        className="block w-full resize-y rounded border border-white/15 bg-neutral-900 p-1 text-neutral-100" />
      <button type="button" onClick={() => { void addToComposer(); }} disabled={!comment.trim() || attaching}
        className="rounded border border-sky-500/50 px-2 py-0.5 disabled:opacity-35">{attaching ? 'Capturing…' : 'Add to chat draft'}</button>
      <button type="button" disabled={attaching} onClick={() => { setSelected(null); setComment(''); }} className="ml-2 underline disabled:opacity-35">Discard</button>
      <p className="text-neutral-500">Adds a highlighted viewport screenshot and element details to the draft; nothing is sent automatically.</p>
    </div> : null}
    {error ? <p role="alert" className="mt-1 text-amber-300">{error}</p> : null}
  </div>;
}
