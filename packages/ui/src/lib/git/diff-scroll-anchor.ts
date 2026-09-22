// SPDX-License-Identifier: Apache-2.0
/**
 * Diff scroll anchoring (doc 06 §5.8): when a diff list refreshes under a
 * live scroll, pick the nearest section to the viewport top and preserve its
 * viewport offset across the refresh instead of letting the list jump.
 */
export interface DiffAnchor {
  path: string;
  topOffset: number;
}

export interface DiffSectionTop {
  path: string;
  top: number;
}

/** The section whose top is nearest above `rootTop` (else the first below). */
export function findDiffScrollAnchor(rootTop: number, sections: DiffSectionTop[]): DiffAnchor | null {
  if (sections.length === 0) return null;
  let beforeTop: DiffSectionTop | null = null;
  let afterTop: DiffSectionTop | null = null;
  for (const section of sections) {
    if (section.top <= rootTop) {
      if (beforeTop === null || section.top > beforeTop.top) beforeTop = section;
    } else if (afterTop === null || section.top < afterTop.top) {
      afterTop = section;
    }
  }
  const anchor = beforeTop ?? afterTop;
  if (anchor === null) return null;
  return { path: anchor.path, topOffset: anchor.top - rootTop };
}

/** Re-derive the scroll position so the anchor keeps its viewport offset,
 * clamped to [0, maxScrollTop]. */
export function getRestoredDiffScrollTop(
  scrollTop: number,
  previousTopOffset: number,
  currentTopOffset: number,
  maxScrollTop: number,
): number {
  return Math.min(Math.max(0, maxScrollTop), Math.max(0, scrollTop + currentTopOffset - previousTopOffset));
}
