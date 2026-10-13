// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ProxyOptions } from 'vite';
import { apiProxy } from '../../../vite.config.ts';
import { browserMutationAllowed } from '../lib/http/request-security.ts';

function forwardedHeaders(options: ProxyOptions, event: 'proxyReq' | 'proxyReqWs', origin: string): Headers {
  const proxy = new EventEmitter();
  options.configure?.(proxy as Parameters<NonNullable<ProxyOptions['configure']>>[0], options);
  const headers = new Headers({ origin, host: '127.0.0.1:3902', 'x-forwarded-host': 'evil.example' });
  const outgoing = { setHeader: (name: string, value: string) => headers.set(name, value) };
  proxy.emit(event, outgoing, { headers: { host: 'localhost:5173' } });
  return headers;
}

describe('Vite dev proxy origin forwarding', () => {
  it('preserves foreign HTTP origins on both API and auth routes and overwrites spoofed forwarding headers', () => {
    for (const options of [apiProxy(), apiProxy(true)]) {
      const headers = forwardedHeaders(options, 'proxyReq', 'https://evil.example');
      expect(headers.get('origin')).toBe('https://evil.example');
      expect(headers.get('x-forwarded-host')).toBe('localhost:5173');
      const request = new Request('http://127.0.0.1:3902/api/fs/delete', { method: 'POST', headers });
      expect(browserMutationAllowed(request)).toBe(false);
    }
  });

  it('admits legitimate dev UI writes without masking the browser origin', () => {
    const headers = forwardedHeaders(apiProxy(), 'proxyReq', 'http://localhost:5173');
    const request = new Request('http://127.0.0.1:3902/auth/session', { method: 'POST', headers });
    expect(browserMutationAllowed(request)).toBe(true);
  });

  it('rewrites Origin only for websocket upgrades', () => {
    const headers = forwardedHeaders(apiProxy(true), 'proxyReqWs', 'http://localhost:5173');
    expect(headers.get('origin')).toBe('http://127.0.0.1:3902');
    expect(headers.get('x-forwarded-host')).toBe('localhost:5173');
  });
});
