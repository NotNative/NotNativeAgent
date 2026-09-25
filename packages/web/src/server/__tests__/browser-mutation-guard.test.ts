// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { browserMutationAllowed } from '../lib/http/request-security.ts';
import { createApp } from '../app.ts';

const TARGET = 'http://127.0.0.1:3902';
function request(path: string, method: string, headers: Record<string, string> = {}): Request {
  return new Request(`${TARGET}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' });
}

describe('unsafe browser request origin gate', () => {
  it('rejects opaque and foreign browser origins, including same-site alternate ports', () => {
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null', host: 'null' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'https://evil.example' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'http://localhost' }))).toBe(false); // packaged-client WS exception is not an HTTP write exception
  });

  it('preserves same-origin, reverse-proxy, and non-browser writes', () => {
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: TARGET, 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'https://nnd.example', host: '127.0.0.1:3902', 'x-forwarded-host': 'nnd.example' }))).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST'))).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null', authorization: 'Bearer cli-token' }))).toBe(false);
    expect(browserMutationAllowed(request('/api/fs/delete', 'POST', { origin: 'null', authorization: 'Bearer cli-token' }), true)).toBe(true);
    expect(browserMutationAllowed(request('/api/fs/delete', 'GET', { origin: 'null' }))).toBe(true);
  });

  it('applies before NND API and auth routes, even in open-auth mode', async () => {
    const app = createApp();
    for (const path of ['/api/fs/delete', '/auth/session']) {
      const blocked = await app.fetch(request(path, 'POST', { origin: 'null', 'content-type': 'text/plain' }));
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toEqual({ error: 'Cross-origin browser write denied' });
    }
  });
});
