// SPDX-License-Identifier: Apache-2.0
/** Exact-page typing into one ordinary, visible form field in the desktop guest. */
export interface PageTypeResult { selector: string; urlBefore: string; typed: true; settled: false }

/** Self-contained for guest serialization. Never returns the field value. */
export function performPageType(selector: string, expectedUrl: string, text: string): PageTypeResult | { error: string } {
  if (typeof text !== 'string' || text.length > 2000) return { error: 'Typed text exceeds the allowed bound.' };
  if (location.href !== expectedUrl) return { error: 'The page changed; take a new snapshot before typing.' };
  let matches: NodeListOf<Element>;
  try { matches = document.querySelectorAll(selector); }
  catch { return { error: 'The CSS selector is invalid.' }; }
  if (matches.length !== 1) return { error: 'The selector must match exactly one editable field.' };
  const element = matches[0];
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement))
    return { error: 'The selected element is not an editable input or textarea.' };
  if (element instanceof HTMLInputElement && !['text', 'search'].includes(element.type))
    return { error: 'This input type is not available for browser typing.' };
  if (element.disabled || element.readOnly || element.closest('[disabled], [aria-disabled="true"], [inert], [hidden]'))
    return { error: 'The selected field is disabled or hidden.' };
  const autocomplete = element.getAttribute('autocomplete')?.trim().toLowerCase() ?? '';
  if (autocomplete && autocomplete !== 'off') return { error: 'Fields with autocomplete are not available for browser typing.' };
  const fieldIdentity = (): string => {
    const labelIds = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/u).filter(Boolean).slice(0, 5);
    return [element.id, element.getAttribute('name'), element.getAttribute('aria-label'), element.getAttribute('placeholder'),
      ...Array.from(element.labels ?? []).slice(0, 5).map((label) => label.textContent?.slice(0, 200)),
      ...labelIds.map((id) => document.getElementById(id)?.textContent?.slice(0, 200))]
      .filter(Boolean).join(' ').toLowerCase();
  };
  const identity = fieldIdentity();
  if (/(password|passwd|secret|token|api.?key|credit.?card|card.?number|cvv|cvc|one.?time.?code|otp|ssn|social.?security)/u.test(identity))
    return { error: 'Sensitive fields are not available for browser typing.' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  if (!element.isConnected || location.href !== expectedUrl) return { error: 'The page changed before typing.' };
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    const style = getComputedStyle(cursor);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none'
      || (style.opacity !== '' && Number(style.opacity) === 0))
      return { error: 'The selected field is not visibly editable.' };
    if (cursor === element && !['', 'none'].includes(style.getPropertyValue('-webkit-text-security').trim().toLowerCase()))
      return { error: 'Sensitive fields are not available for browser typing.' };
  }
  const rect = element.getBoundingClientRect();
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  if (rect.width < 1 || rect.height < 1 || centerX < 0 || centerY < 0 || centerX >= innerWidth || centerY >= innerHeight
    || !element.contains(document.elementFromPoint(centerX, centerY)))
    return { error: 'The selected field is not visibly editable.' };
  if (!element.isConnected || location.href !== expectedUrl) return { error: 'The page changed before typing.' };
  if (element.disabled || element.readOnly || element.closest('[disabled], [aria-disabled="true"], [inert], [hidden]')
    || (element instanceof HTMLInputElement && !['text', 'search'].includes(element.type))
    || (element.getAttribute('autocomplete')?.trim().toLowerCase() ?? '') !== autocomplete
    || fieldIdentity() !== identity)
    return { error: 'The field changed before typing.' };
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) return { error: 'The field cannot be edited.' };
  setter.call(element, text);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return { selector, urlBefore: expectedUrl, typed: true, settled: false };
}

export function pageTypeScript(selector: string, expectedUrl: string, text: string): string {
  return `(${performPageType.toString()})(${JSON.stringify(selector)}, ${JSON.stringify(expectedUrl)}, ${JSON.stringify(text)})`;
}

export function parsePageType(value: unknown, selector: string, expectedUrl: string): PageTypeResult | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<PageTypeResult>;
  return item.selector === selector && item.urlBefore === expectedUrl && item.typed === true
    && item.settled === false && Object.keys(item).length === 4 ? item as PageTypeResult : null;
}
