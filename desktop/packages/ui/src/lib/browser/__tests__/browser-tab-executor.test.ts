// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { previewProxyUrl, bridgeHandlerSource } from '../browser-tab-executor.ts';

function bridgePerform(): (action: string, parameters: Record<string, unknown>) => unknown {
  const built = new Function(bridgeHandlerSource() + ';return window.__nndBrowserBridgePerform;')() as
    (action: string, parameters: Record<string, unknown>) => unknown;
  return built;
}

describe('browser-tab executor', () => {
  it('maps loopback dev-server pages onto the same-origin proxy path', () => {
    expect(previewProxyUrl('http://127.0.0.1:5173/')).toBe('/api/preview-proxy/5173');
    expect(previewProxyUrl('http://localhost:3000/app/index.html?a=1'))
      .toBe('/api/preview-proxy/3000/app/index.html?a=1');
    expect(previewProxyUrl('https://example.com/')).toBeNull();
    expect(previewProxyUrl('not a url')).toBeNull();
  });

  it('bridge snapshots and inspects the page document', () => {
    document.title = 'Fixture';
    document.body.innerHTML = '<button data-testid="go">Go</button><p>hello world</p>';
    const perform = bridgePerform();
    const snapshot = perform('browser.snapshot', {}) as { title: string; text: string; nodeCount: number };
    expect(snapshot.title).toBe('Fixture');
    expect(snapshot.text).toContain('hello world');
    expect(snapshot.nodeCount).toBeGreaterThan(0);
    const inspection = perform('browser.inspect', { selector: '[data-testid="go"]' }) as
      { count: number; html: string };
    expect(inspection.count).toBe(1);
    expect(inspection.html).toContain('Go');
    expect((perform('browser.inspect', { selector: '[data-testid="missing"]' }) as { count: number }).count).toBe(0);
  });

  it('bridge types through the React-safe value setter and clicks real elements', () => {
    document.body.innerHTML = '<input id="field" /><button id="send">Send</button>';
    let clicked = 0;
    (document.getElementById('send') as HTMLElement).addEventListener('click', () => { clicked += 1; });
    const perform = bridgePerform();
    expect(perform('browser.type', { selector: '#field', text: 'typed text' })).toEqual({ typed: true });
    expect((document.getElementById('field') as HTMLInputElement).value).toBe('typed text');
    expect(perform('browser.click', { selector: '#send' })).toEqual({ clicked: true });
    expect(clicked).toBe(1);
    expect(() => perform('browser.type', { selector: '#missing', text: 'x' })).toThrow(/not a text field/);
    expect(() => perform('browser.click', { selector: '#missing' })).toThrow(/not found/);
    expect(() => perform('browser.capture', {})).toThrow(/Unsupported browser action/);
  });
});
