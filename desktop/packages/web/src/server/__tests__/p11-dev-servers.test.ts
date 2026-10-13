// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createDevServerScanner, parseNetstatListeners, registerDevServerRoutes,
  selectDevServers } from '../preview/dev-servers.ts';

const netstat = [
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242',
  '  TCP    [::1]:5173             [::]:0                 LISTENING       4242',
  '  TCP    0.0.0.0:3902           0.0.0.0:0              LISTENING       3000',
  '  TCP    192.168.1.5:8080      0.0.0.0:0              LISTENING       55',
  '  TCP    127.0.0.1:5432         0.0.0.0:0              LISTENING       77',
  '  TCP    127.0.0.1:9000         127.0.0.1:3000         ESTABLISHED     88',
].join('\r\n');

describe('P11 Windows dev-server discovery', () => {
  it('selects real loopback/wildcard listeners and excludes own, ignored, and established ports', () => {
    const parsed = parseNetstatListeners(netstat);
    expect(parsed.map((item) => item.port)).toEqual([3902, 5173, 5432]);
    expect(selectDevServers(parsed, [3902], 3000)).toEqual([
      { port: 5173, pid: 4242, command: '', url: 'http://localhost:5173/' },
    ]);
  });

  it('caches success for three seconds but never a failed scan', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockRejectedValueOnce(new Error('missing netstat')).mockResolvedValue(netstat);
      const scan = createDevServerScanner({ platform: 'win32', run, ownPorts: () => [3902], ownPid: 3000 });
      await expect(scan()).resolves.toEqual({ ok: false, reason: 'netstat-unavailable' });
      await expect(scan()).resolves.toMatchObject({ ok: true, servers: [{ port: 5173 }] });
      await scan();
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3000);
      await scan();
      expect(run).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });

  it('excludes a managed harness port supplied at runtime', async () => {
    const scan = createDevServerScanner({ platform: 'win32', run: async () => netstat,
      ownPorts: () => [3902, 5173], ownPid: 3000 });
    await expect(scan()).resolves.toEqual({ ok: true, servers: [] });
  });

  it('treats empty command output as scan failure', async () => {
    const scan = createDevServerScanner({ platform: 'win32', run: async () => '  \r\n',
      ownPorts: () => [], ownPid: 3000 });
    await expect(scan()).resolves.toEqual({ ok: false, reason: 'netstat-unavailable' });
  });

  it('answers 503 on scan failure, not a false empty list', async () => {
    const app = new Hono();
    registerDevServerRoutes(app, async () => ({ ok: false, reason: 'netstat-unavailable' }));
    const response = await app.request('/api/dev-servers');
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Port discovery is unavailable', reason: 'netstat-unavailable' });
  });
});
