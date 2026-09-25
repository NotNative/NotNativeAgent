// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserSurface } from '../browser-surface.tsx';

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; container = null; });

function render(): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<BrowserSurface />));
  return container;
}

function enter(address: string): void {
  const input = container!.querySelector('input[aria-label="Preview address"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, address);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

describe('BrowserSurface', () => {
  it('starts empty and only loads a user-submitted URL in a sandboxed frame', () => {
    const view = render();
    expect(view.querySelector('iframe')).toBeNull();
    enter('localhost:5173');
    const frame = view.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('http://localhost:5173/');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(view.querySelector('a')?.getAttribute('href')).toBe('http://localhost:5173/');
  });

  it('supports own back/forward history and reload without navigating to invalid URLs', () => {
    const view = render();
    enter('localhost:5173/one');
    enter('localhost:5173/two');
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    act(() => (view.querySelector('[aria-label="Preview back"]') as HTMLButtonElement).click());
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/one');
    act(() => (view.querySelector('[aria-label="Preview forward"]') as HTMLButtonElement).click());
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    const frame = view.querySelector('iframe');
    act(() => (view.querySelector('[aria-label="Reload preview"]') as HTMLButtonElement).click());
    expect(view.querySelector('iframe')).not.toBe(frame);
    enter('javascript:alert(1)');
    expect(view.querySelector('iframe')?.getAttribute('src')).toBe('http://localhost:5173/two');
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
  });
});
