// SPDX-License-Identifier: Apache-2.0
/** Exact-page, bounded viewport scroll in the isolated desktop guest. */
export type ScrollDirection = 'up' | 'down' | 'top' | 'bottom';
export interface PageScrollResult { urlBefore: string; direction: ScrollDirection;
  scrollY: number; maxScrollY: number; atTop: boolean; atBottom: boolean; settled: true }

/** Self-contained for serialization into the guest realm. */
export async function performPageScroll(direction: ScrollDirection, expectedUrl: string): Promise<PageScrollResult | { error: string }> {
  if (location.href !== expectedUrl) return { error: 'The page changed; take a new snapshot before scrolling.' };
  const root = document.scrollingElement ?? document.documentElement;
  const maxScrollY = Math.max(0, root.scrollHeight - innerHeight);
  const step = Math.max(1, Math.round(innerHeight * 0.8));
  const target = direction === 'top' ? 0 : direction === 'bottom' ? maxScrollY
    : direction === 'up' ? Math.max(0, scrollY - step) : Math.min(maxScrollY, scrollY + step);
  scrollTo({ top: target, behavior: 'instant' });
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (location.href !== expectedUrl) return { error: 'The page changed while scrolling.' };
  const currentMax = Math.max(0, (document.scrollingElement ?? document.documentElement).scrollHeight - innerHeight);
  const currentY = Math.max(0, scrollY);
  return { urlBefore: expectedUrl, direction, scrollY: currentY, maxScrollY: currentMax,
    atTop: currentY <= 1, atBottom: currentY >= currentMax - 1, settled: true };
}

export function pageScrollScript(direction: ScrollDirection, expectedUrl: string): string {
  return `(${performPageScroll.toString()})(${JSON.stringify(direction)}, ${JSON.stringify(expectedUrl)})`;
}

export function parsePageScroll(value: unknown, direction: ScrollDirection, expectedUrl: string): PageScrollResult | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PageScrollResult>;
  return item.urlBefore === expectedUrl && item.direction === direction && item.settled === true
    && typeof item.scrollY === 'number' && Number.isFinite(item.scrollY) && item.scrollY >= 0
    && typeof item.maxScrollY === 'number' && Number.isFinite(item.maxScrollY) && item.maxScrollY >= 0
    && typeof item.atTop === 'boolean' && typeof item.atBottom === 'boolean'
    && Object.keys(item).length === 7 ? item as PageScrollResult : null;
}
