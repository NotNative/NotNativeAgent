// SPDX-License-Identifier: Apache-2.0
/**
 * Review refresh hints (doc 06 §5.9 + §11.4 minimal port): one tiny
 * pub/sub that carries "this path/scope changed, review surfaces refresh
 * it" between the mutating surfaces (FilesView save/dialogs, GitView/DiffView
 * index mutations, sync side effects) and the retained review views.
 *
 * Buffering contract (§13#1): consumers ALWAYS accumulate into a merged
 * buffer; a visible view replays the buffer on a macrotask cadence (bounded
 * by the next render), and replaying once on reveal covers everything that
 * happened while the view was hidden. Overflow degrades to a path-less
 * "refresh the scope" hint instead of growing unbounded.
 */
import { useEffect, useRef } from 'react';

export interface ReviewRefreshHint {
  directory: string;
  paths: string[] | null;
  reasons: string[];
}

type Listener = (hint: ReviewRefreshHint) => void;

const MAX_HINT_PATHS = 128;
const listeners = new Set<Listener>();

export function publishReviewRefresh(directory: string, paths: string[] | null, reason: string): void {
  const hint: ReviewRefreshHint = { directory, paths, reasons: [reason] };
  for (const listener of [...listeners]) listener(hint);
}

export function subscribeReviewRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Mutable merged accumulator (never a fresh allocation per hint). */
export class ReviewRefreshBuffer {
  readonly directory: string;
  private dirty = false;
  private pathless = false;
  private mergedPaths: string[] = [];
  private mergedReasons = new Set<string>();

  constructor(directory: string) {
    this.directory = directory;
  }

  add(directory: string, paths: string[] | null, reason: string): void {
    if (directory !== this.directory) return;
    this.dirty = true;
    this.mergedReasons.add(reason);
    if (paths === null) {
      this.pathless = true; // path-less hint wins: everything is stale
      this.mergedPaths = [];
      return;
    }
    if (this.pathless) return;
    for (const path of paths) {
      if (!this.mergedPaths.includes(path)) this.mergedPaths.push(path);
    }
    if (this.mergedPaths.length > MAX_HINT_PATHS) {
      this.pathless = true;
      this.mergedPaths = [];
    }
  }

  drain(): ReviewRefreshHint | null {
    if (!this.dirty) return null;
    if (this.mergedReasons.size === 0 && !this.pathless && this.mergedPaths.length === 0) return null;
    const hint: ReviewRefreshHint = {
      directory: this.directory,
      paths: this.pathless ? null : [...this.mergedPaths],
      reasons: [...this.mergedReasons],
    };
    this.dirty = false;
    this.pathless = false;
    this.mergedPaths = [];
    this.mergedReasons = new Set();
    return hint;
  }

  __isEmptyForTests(): boolean {
    return !this.dirty && this.mergedReasons.size === 0 && !this.pathless && this.mergedPaths.length === 0;
  }
}

/**
 * §13#1 buffered replay consumer: hints for `directory` accumulate while the
 * view is hidden and flush once on reveal; while visible, arrivals coalesce
 * and replay on the next macrotask (one refresh pass per burst). `replay`
 * receives the merged hint (or null when nothing accumulated).
 */
export function useReviewRefreshHints(
  directory: string,
  visible: boolean,
  replay: (hint: ReviewRefreshHint) => void,
): void {
  const bufferRef = useRef(new ReviewRefreshBuffer(directory));
  const replayRef = useRef(replay);
  replayRef.current = replay;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const buffer = bufferRef.current;
    const schedule = (): void => {
      if (timerRef.current !== null || !visibleRef.current) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!visibleRef.current) return;
        const hint = buffer.drain();
        if (hint !== null) replayRef.current(hint);
      }, 0);
    };
    const unsubscribe = subscribeReviewRefresh((_hint) => {
      buffer.add(_hint.directory, _hint.paths, _hint.reasons[0] ?? 'unknown');
      schedule();
    });
    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // Hidden→visible replay: flush what accumulated while hidden.
  useEffect(() => {
    if (!visible) return undefined;
    const hint = bufferRef.current.drain();
    if (hint !== null) replayRef.current(hint);
    return undefined;
  }, [visible]);
}

export function __resetReviewRefreshForTests(): void {
  listeners.clear();
}
