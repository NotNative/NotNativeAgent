// SPDX-License-Identifier: Apache-2.0
/** Responsive default plus an explicit per-runtime/workspace/surface width. */
import { useEffect, useRef, useState } from 'react';
import { clampRailWidth, preferredRailWidth, readWidth, surfaceWidthStorageKey } from './operator-rail-width.ts';

export function useOperatorRailWidth(directoryKey: string, surface: string): {
  width: number; viewportWidth: number; resize: (next: number) => void; fit: () => void;
} {
  const widthKey = surfaceWidthStorageKey(directoryKey, surface);
  const [saved, setSaved] = useState(() => ({ key: widthKey, value: readWidth(widthKey, surface), touched: false }));
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1280 : window.innerWidth);
  const width = clampRailWidth(saved.key === widthKey && saved.touched ? saved.value : readWidth(widthKey, surface), viewportWidth);
  const displayedWidth = useRef(width);
  displayedWidth.current = width;

  useEffect(() => {
    const updateViewport = (): void => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);
  useEffect(() => {
    if (saved.key !== widthKey) setSaved({ key: widthKey, value: readWidth(widthKey, surface), touched: false });
  }, [saved.key, surface, widthKey]);
  useEffect(() => {
    if (saved.key !== widthKey || widthKey === null || !saved.touched) return;
    try { localStorage.setItem(widthKey, String(saved.value)); } catch { /* optional device preference */ }
  }, [saved.key, saved.value, saved.touched, widthKey]);

  const resize = (next: number): void => {
    const resized = clampRailWidth(next, viewportWidth);
    // Ignore a no-op at the viewport cap, preserving an ultrawide saved
    // preference. Pointer listeners can be older than the latest render.
    if (resized !== displayedWidth.current) {
      displayedWidth.current = resized;
      setSaved({ key: widthKey, value: resized, touched: true });
    }
  };
  const fit = (): void => {
    // Fit remains responsive after this window changes size. Only the active
    // runtime/workspace/surface override is removed.
    if (widthKey !== null) {
      try { localStorage.removeItem(widthKey); } catch { /* optional device preference */ }
    }
    setSaved({ key: widthKey, value: preferredRailWidth(surface, viewportWidth), touched: false });
  };
  return { width, viewportWidth, resize, fit };
}
