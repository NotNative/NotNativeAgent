// SPDX-License-Identifier: Apache-2.0
/** Exact-page, single-selector activation in the isolated desktop guest. */
export interface PageClickResult { selector: string; urlBefore: string; activated: true; settled: false }

/** Self-contained for guest serialization. The return records activation, not downstream effect. */
export function performPageClick(selector: string, expectedUrl: string): PageClickResult | { error: string } {
  if (location.href !== expectedUrl) return { error: 'The page changed; take a new snapshot before clicking.' };
  let element: Element | null;
  try { element = document.querySelector(selector); }
  catch { return { error: 'The CSS selector is invalid.' }; }
  if (!(element instanceof HTMLElement)) return { error: 'No clickable HTML element matches the selector.' };
  if (element.closest('[disabled], [aria-disabled="true"], [inert]'))
    return { error: 'The selected element is disabled.' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (!element.isConnected || location.href !== expectedUrl) return { error: 'The page changed before clicking.' };
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    const style = getComputedStyle(cursor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none'
      || (style.opacity !== '' && Number(style.opacity) === 0))
      return { error: 'The selected element is not visibly clickable.' };
  }
  const rect = element.getBoundingClientRect();
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  if (rect.width < 1 || rect.height < 1 || centerX < 0 || centerY < 0
    || centerX >= innerWidth || centerY >= innerHeight) return { error: 'The selected element is not visibly clickable.' };
  const hit = document.elementFromPoint(centerX, centerY);
  if (hit !== element && !element.contains(hit))
    return { error: 'The selected element is covered by another element.' };
  if (!element.isConnected || location.href !== expectedUrl)
    return { error: 'The page changed before clicking.' };
  element.click();
  return { selector, urlBefore: expectedUrl, activated: true, settled: false };
}

export function pageClickScript(selector: string, expectedUrl: string): string {
  return `(${performPageClick.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(expectedUrl)})`;
}

export function parsePageClick(value: unknown, selector: string, expectedUrl: string): PageClickResult | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PageClickResult>;
  return item.selector === selector && item.urlBefore === expectedUrl && item.activated === true
    && item.settled === false && Object.keys(item).length === 4 ? item as PageClickResult : null;
}
