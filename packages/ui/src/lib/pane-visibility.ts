// SPDX-License-Identifier: Apache-2.0
/**
 * Pane-visibility primitives (W-55): panes that stay mounted while hidden
 * (suppressed rails, CSS-hidden columns, background tabs) must pause their
 * periodic work. Document-level gates already exist (event pipeline, file
 * freshness poller, terminal wake); these primitives add the pane level:
 * a visibility-gated interval and an IntersectionObserver hook.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function subscribeDocumentVisibility(callback: (visible: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const listener = (): void => callback(isDocumentVisible());
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

/** setInterval that skips the tick while the document is hidden and runs it
 * once immediately on returning visible. Returns the stop function. */
export function createVisibilityGatedInterval(tick: () => void, milliseconds: number): () => void {
  const timer = window.setInterval(() => { if (isDocumentVisible()) tick(); }, milliseconds);
  const stopVisibility = subscribeDocumentVisibility(visible => { if (visible) tick(); });
  return () => { window.clearInterval(timer); stopVisibility(); };
}

/** True while the referenced element intersects the viewport. Retained
 * (display:none / clipped) panes report false. Without IntersectionObserver
 * support the pane is assumed visible. */
export function usePaneVisible(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(true);
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return undefined;
    observer.current = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { threshold: 0 });
    observer.current.observe(element);
    return () => { observer.current?.disconnect(); observer.current = null; };
  }, [ref]);
  return visible;
}
