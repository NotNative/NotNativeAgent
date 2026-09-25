// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { normalizePreviewUrl } from '../preview-url.ts';

const APP = 'http://127.0.0.1:4111';

describe('normalizePreviewUrl', () => {
  it('defaults local listeners to HTTP and public hosts to HTTPS', () => {
    expect(normalizePreviewUrl(' localhost:5173/demo ', APP)).toBe('http://localhost:5173/demo');
    expect(normalizePreviewUrl('localhost.:5173/demo', APP)).toBe('http://localhost.:5173/demo');
    expect(normalizePreviewUrl('[::1]:5173', APP)).toBe('http://[::1]:5173/');
    expect(normalizePreviewUrl('example.com/docs', APP)).toBe('https://example.com/docs');
    expect(normalizePreviewUrl('http://example.com', APP)).toBe('http://example.com/');
  });

  it('rejects privileged protocols, credentials, and the app listener through loopback aliases', () => {
    for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//example.com',
      'https://user:secret@example.com', 'http://127.0.0.1:4111/', 'http://localhost:4111/',
      'http://localhost.:4111/', 'localhost.:4111/', 'http://[::1]:4111/', '']) {
      expect(normalizePreviewUrl(value, APP), value).toBeNull();
    }
    expect(normalizePreviewUrl('http://localhost:5173/', APP)).toBe('http://localhost:5173/');
  });
});
