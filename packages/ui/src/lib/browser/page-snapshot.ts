// SPDX-License-Identifier: Apache-2.0
/** Bounded, read-only DOM summary evaluated inside the unprivileged guest. */
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  textTotalChars: number;
  textTruncated: boolean;
  elements: Array<{ selector: string; tag: string; label: string; bounds: {
    x: number; y: number; width: number; height: number;
  } }>;
  interactiveElementsOnPage: number;
  elementsTruncated: boolean;
}

// Keep this function self-contained: Electron serializes its source into the
// guest realm. No NND bridge, cookies, input values, or page scripts are read.
export function collectPageSnapshot(): PageSnapshot {
  const maxText = 6000;
  const maxElements = 120;
  const rawText = (document.body?.innerText ?? '').replace(/\s+/gu, ' ').trim();
  const candidates = document.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]',
  );
  const elements: PageSnapshot['elements'] = [];
  let count = 0;
  for (const element of candidates) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden'
      || (style.opacity !== '' && Number(style.opacity) === 0)) continue;
    count += 1;
    if (elements.length >= maxElements) continue;
    const chain: string[] = [];
    let cursor: Element | null = element;
    while (cursor && cursor !== document.documentElement) {
      const parent: Element | null = cursor.parentElement;
      const peers = parent ? Array.from(parent.children).filter((item) => item.tagName === cursor!.tagName) : [];
      chain.unshift(`${cursor.tagName.toLowerCase()}:nth-of-type(${peers.indexOf(cursor) + 1})`);
      cursor = parent;
    }
    const label = (element.getAttribute('aria-label') || element.getAttribute('title')
      || element.getAttribute('alt') || element.innerText || element.getAttribute('placeholder') || '')
      .replace(/\s+/gu, ' ').trim().slice(0, 80);
    elements.push({ selector: chain.join(' > '), tag: element.tagName.toLowerCase(), label,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
  }
  return { url: location.href, title: document.title.slice(0, 200), text: rawText.slice(0, maxText),
    textTotalChars: rawText.length, textTruncated: rawText.length > maxText, elements,
    interactiveElementsOnPage: count, elementsTruncated: count > maxElements };
}

export function pageSnapshotScript(): string {
  return `(${collectPageSnapshot.toString()})()`;
}

/** The guest result crosses a process boundary; never trust its shape. */
export function parsePageSnapshot(value: unknown): PageSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PageSnapshot>;
  if (typeof item.url !== 'string' || item.url.length > 16384
    || typeof item.title !== 'string' || item.title.length > 200 || typeof item.text !== 'string'
    || item.text.length > 6000 || typeof item.textTotalChars !== 'number'
    || !Number.isSafeInteger(item.textTotalChars) || item.textTotalChars < item.text.length
    || typeof item.textTruncated !== 'boolean' || !Array.isArray(item.elements) || item.elements.length > 120
    || typeof item.interactiveElementsOnPage !== 'number'
    || !Number.isSafeInteger(item.interactiveElementsOnPage) || item.interactiveElementsOnPage < item.elements.length
    || typeof item.elementsTruncated !== 'boolean') return null;
  if (!item.elements.every((element) => element && typeof element.selector === 'string'
    && element.selector.length <= 1000 && typeof element.tag === 'string'
    && typeof element.label === 'string' && element.label.length <= 80
    && element.bounds && ['x', 'y', 'width', 'height'].every((key) =>
      Number.isFinite(element.bounds[key as keyof typeof element.bounds])))) return null;
  return item as PageSnapshot;
}
