// SPDX-License-Identifier: Apache-2.0
/** Read-only computed-style observation inside the isolated desktop guest. */
export interface PageInspection {
  url: string;
  selector: string;
  tag: string;
  label: string;
  bounds: { x: number; y: number; width: number; height: number };
  style: { display: string; visibility: string; position: string; color: string;
    backgroundColor: string; fontSize: string; fontFamily: string; zIndex: string };
}

/** Self-contained for serialization into the guest; never reads input values. */
export function collectPageInspection(selector: string): PageInspection | { error: string } {
  let element: Element | null;
  try { element = document.querySelector(selector); }
  catch { return { error: 'The CSS selector is invalid.' }; }
  if (!element) return { error: 'No element matches the CSS selector.' };
  const rect = element.getBoundingClientRect();
  const computed = getComputedStyle(element);
  // Security: text content of editable controls can be a user's draft or a
  // server-rendered initial value, even when the value property is not read.
  const editable = element.matches('input, textarea, select, [contenteditable]')
    || element.closest('[contenteditable]') !== null;
  const label = (element.getAttribute('aria-label') || element.getAttribute('title')
    || (!editable ? (element instanceof HTMLElement ? element.innerText : element.textContent) : '') || '')
    .replace(/\s+/gu, ' ').trim().slice(0, 200);
  return { url: location.href, selector, tag: element.tagName.toLowerCase(), label,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    style: { display: computed.display, visibility: computed.visibility, position: computed.position,
      color: computed.color, backgroundColor: computed.backgroundColor, fontSize: computed.fontSize,
      fontFamily: computed.fontFamily, zIndex: computed.zIndex } };
}

export function pageInspectionScript(selector: string): string {
  return `(${collectPageInspection.toString()})(${JSON.stringify(selector)})`;
}

export function parsePageInspection(value: unknown, selector: string): PageInspection | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PageInspection>;
  const style = item.style;
  const bounds = item.bounds;
  return typeof item.url === 'string' && item.url.length <= 16384
    && item.selector === selector && typeof item.tag === 'string' && item.tag.length <= 64
    && typeof item.label === 'string' && item.label.length <= 200 && !!bounds
    && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key as keyof typeof bounds]))
    && !!style && Object.keys(style).length === 8
    && ['display', 'visibility', 'position', 'color', 'backgroundColor', 'fontSize', 'fontFamily', 'zIndex']
      .every((key) => typeof style[key as keyof typeof style] === 'string'
        && (style[key as keyof typeof style] as string).length <= 300) ? item as PageInspection : null;
}
