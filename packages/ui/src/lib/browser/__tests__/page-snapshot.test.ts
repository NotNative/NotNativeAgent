// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { collectPageSnapshot, pageSnapshotScript, parsePageSnapshot } from '../page-snapshot.ts';

afterEach(() => { document.body.innerHTML = ''; document.title = ''; });

describe('read-only page snapshot', () => {
  it('caps text and elements, omits input values, and reports truncation', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Save');
    button.getBoundingClientRect = () => ({ x: 4, y: 5, width: 30, height: 20 } as DOMRect);
    document.body.append(button);
    for (let idx = 0; idx < 121; idx += 1) {
      const input = document.createElement('input');
      input.type = 'password'; input.value = `secret-${idx}`;
      input.getBoundingClientRect = () => ({ x: 0, y: 0, width: 20, height: 10 } as DOMRect);
      document.body.append(input);
    }
    Object.defineProperty(document.body, 'innerText', { configurable: true, value: 'x'.repeat(6100) });
    const result = collectPageSnapshot();
    expect(result.text).toHaveLength(6000);
    expect(result.textTruncated).toBe(true);
    expect(result.interactiveElementsOnPage).toBe(122);
    expect(result.elements).toHaveLength(120);
    expect(result.elementsTruncated).toBe(true);
    expect(result.elements[0]?.label).toBe('Save');
    expect(JSON.stringify(result)).not.toContain('secret-');
  });

  it('emits a self-contained guest expression and rejects malformed boundary results', () => {
    document.body.innerHTML = '<button>Ready</button>';
    const script = pageSnapshotScript();
    const execute = new Function('document', 'location', 'getComputedStyle', `return ${script}`);
    const value: unknown = execute(document, window.location, window.getComputedStyle.bind(window));
    expect(parsePageSnapshot(value)?.url).toBe(window.location.href);
    expect(parsePageSnapshot({ ...(value as object), text: 'x'.repeat(6001) })).toBeNull();
    expect(parsePageSnapshot({ ...(value as object), title: 'x'.repeat(201) })).toBeNull();
    expect(parsePageSnapshot({ ...(value as object), url: `https://example.org/${'x'.repeat(16384)}` })).toBeNull();
    expect(parsePageSnapshot({ ...(value as object), elements: [{ selector: '#x', label: 'x', tag: 'button', bounds: { x: Infinity } }] })).toBeNull();
  });
});
