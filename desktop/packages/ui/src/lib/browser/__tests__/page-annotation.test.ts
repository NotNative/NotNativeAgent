// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { annotationScript, formatAnnotationDraft, parsePageAnnotation, selectPageElement } from '../page-annotation.ts';

afterEach(() => {
  Reflect.deleteProperty(document, 'elementFromPoint');
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('uses a bounded read-only hit test after the host catches the click', () => {
  const button = document.createElement('button');
  button.textContent = 'Submit';
  button.getBoundingClientRect = () => ({ x: 4, y: 5, width: 60, height: 20 } as DOMRect);
  document.body.append(button);
  const hit = vi.fn(() => button);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  const pageClick = vi.fn();
  window.addEventListener('click', pageClick, true);
  const execute = new Function(`return ${annotationScript(location.href, 0.25, 0.5)}`) as () => unknown;
  const result = execute();
  expect(hit).toHaveBeenCalledWith(window.innerWidth / 4, window.innerHeight / 2);
  expect(result).toMatchObject({ url: location.href, tag: 'button', label: 'Submit', bounds: { width: 60 } });
  expect(result).toMatchObject({ viewport: { width: window.innerWidth, height: window.innerHeight } });
  expect(pageClick).not.toHaveBeenCalled();
  expect(document.querySelector('[data-nnd-annotation]')).toBeNull();
  window.removeEventListener('click', pageClick, true);
});

it('refuses stale pages and out-of-viewport coordinates', () => {
  const hit = vi.fn();
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  expect(selectPageElement('https://different.example/', 0.5, 0.5)).toBeNull();
  expect(selectPageElement(location.href, -0.1, 0.5)).toBeNull();
  expect(selectPageElement(location.href, 0.5, Infinity)).toBeNull();
  expect(hit).not.toHaveBeenCalled();
  expect(annotationScript(location.href, 0.25, 0.5)).toContain('selectPageElement');
});

it('does not copy editable values exposed through page-provided labels', () => {
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'unsent secret');
  input.title = 'another secret';
  input.getBoundingClientRect = () => ({ x: 4, y: 5, width: 60, height: 20 } as DOMRect);
  document.body.append(input);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => input });
  expect(selectPageElement(location.href, 0.5, 0.5)?.label).toBe('');
  expect(parsePageAnnotation({ url: location.href, tag: 'button', selector: 'button', label: '',
    bounds: { x: 0, y: 0, width: 5, height: Infinity } })).toBeNull();
});

it('formats a structured draft that claims the screenshot only after the composer accepts it', () => {
  const annotation = { url: 'https://example.org/', tag: 'button', selector: 'html > body > button',
    label: 'Save', bounds: { x: 1, y: 2, width: 30, height: 20 },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 } };
  expect(formatAnnotationDraft(annotation, 'Please inspect this.')).toContain('highlighted viewport screenshot attached');
  expect(formatAnnotationDraft(annotation, 'Please inspect this.')).toContain('User comment: Please inspect this.');
});
