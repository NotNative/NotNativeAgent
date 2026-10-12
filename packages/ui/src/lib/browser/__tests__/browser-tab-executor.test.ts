// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { previewProxyUrl, executeBrowserSnapshot, executeBrowserCapture, executeBrowserInspect } from '../browser-tab-executor.ts';

function mountProxyFrame(body: string): { frame: HTMLIFrameElement; host: HTMLElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const frame = document.createElement('iframe');
  host.append(frame);
  frame.srcdoc = body;
  return { frame, host };
}

describe('browser-tab executor URL scoping', () => {
  it('maps loopback dev-server pages onto the same-origin proxy path', () => {
    expect(previewProxyUrl('http://127.0.0.1:5173/')).toBe('/api/preview-proxy/5173');
    expect(previewProxyUrl('http://localhost:3000/app/index.html?a=1'))
      .toBe('/api/preview-proxy/3000/app/index.html?a=1');
    expect(previewProxyUrl('https://example.com/')).toBeNull();
    expect(previewProxyUrl('not a url')).toBeNull();
  });

  it('refuses actions when no same-origin document is available', () => {
    expect(() => executeBrowserSnapshot(null)).toThrow(/same-origin preview proxy/);
    expect(() => executeBrowserCapture(null, 'http://127.0.0.1:5173/')).toThrow(/same-origin preview proxy/);
  });

  it('snapshots and inspects a same-origin proxied document', () => {
    const { frame, host } = mountProxyFrame('<button data-testid="go">Go</button><p>hello world</p>');
    return new Promise<void>((resolve) => {
      frame.addEventListener('load', () => {
        try {
          const snapshot = executeBrowserSnapshot(frame);
          expect(snapshot.text).toContain('hello world');
          const inspection = executeBrowserInspect(frame, '[data-testid="go"]');
          expect(inspection.count).toBe(1);
          expect(inspection.html).toContain('Go');
          expect(executeBrowserInspect(frame, '[data-testid="missing"]').count).toBe(0);
          resolve();
        } finally { host.remove(); }
      });
    });
  });

  it('marks DOM capture as rendered:false and never claims an image', () => {
    const { frame, host } = mountProxyFrame('<main>capture body</main>');
    return new Promise<void>((resolve) => {
      frame.addEventListener('load', () => {
        try {
          const doc = frame.contentDocument!;
          const capture = executeBrowserCapture(frame, doc.location!.href);
          expect(capture.mime).toBe('text/html;mode=dom');
          expect(capture.rendered).toBe(false);
          expect(capture.html).toContain('capture body');
          expect(() => executeBrowserCapture(frame, 'http://127.0.0.1:5173/other'))
            .toThrow(/take a new snapshot/);
          resolve();
        } finally { host.remove(); }
      });
    });
  });
});
