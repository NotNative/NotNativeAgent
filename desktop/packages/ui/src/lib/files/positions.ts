// SPDX-License-Identifier: Apache-2.0
/**
 * File position restore (doc 06 §3.4): Map<positionKey, { scroll, anchor,
 * head }> keyed by JSON[runtimeKey, root, path] (+ ':fullscreen' suffix);
 * saved on editor destroy, clamped + re-applied on mount (sticky — the map
 * entry survives until the next destroy-save overwrites it), capped at 100
 * entries FIFO. Textarea-host v1 stores scrollTop + caret range (delta E20:
 * the CodeMirror scrollSnapshot/selection swap keeps the same contract).
 */
const MAX_POSITIONS = 100;

export interface FilePosition {
  /** scrollTop of the host scroller. */
  scroll: number;
  /** caret selection range (textarea v1; selectionStart). */
  anchor: number;
  /** caret head (selectionEnd). */
  head: number;
}

function positionKey(runtimeKey: string, root: string, path: string, fullscreen = false): string {
  return JSON.stringify([runtimeKey, root, path, fullscreen ? ':fullscreen' : '']);
}

const positions = new Map<string, FilePosition>();

export function saveFilePosition(runtimeKey: string, root: string, path: string, position: FilePosition, fullscreen = false): void {
  const key = positionKey(runtimeKey, root, path, fullscreen);
  positions.delete(key); // re-insert moves the entry to map order tail
  positions.set(key, position);
  while (positions.size > MAX_POSITIONS) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
}

/** §3.4: returns the stored position (re-applied on mount; entry STAYS until
 * the next destroy-save overwrites it — sticky, doc-accurate). */
export function getFilePosition(runtimeKey: string, root: string, path: string, fullscreen = false): FilePosition | null {
  return positions.get(positionKey(runtimeKey, root, path, fullscreen)) ?? null;
}

/** §3.4: clamp a restored caret into the current document length. */
export function clampCaret(caret: number, contentLength: number): number {
  if (!Number.isFinite(caret) || caret < 0) return 0;
  return Math.min(caret, Math.max(0, contentLength));
}

export function positionCount(): number {
  return positions.size;
}

export function __resetPositionsForTests(): void {
  positions.clear();
}
