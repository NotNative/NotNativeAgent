// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { nativeServiceTerminalUnavailable } from '../env.ts';
import type { TerminalRuntime } from '../terminal/session-core.ts';

afterEach(() => vi.unstubAllEnvs());

it('refuses installed native terminal commands before a PTY is created', async () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  const shells = vi.fn(() => []);
  const createSession = vi.fn();
  const app = createApp({ terminal: { shells, createSession } as unknown as TerminalRuntime });
  expect(nativeServiceTerminalUnavailable()).toBe(true);
  const listed = await app.request('/api/terminal/shells');
  expect(listed.status).toBe(409);
  expect(await listed.json()).toMatchObject({ code: 'native_terminal_unavailable' });
  const created = await app.request('/api/terminal/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: 'C:/unadmitted', mode: 'command', command: 'whoami' }),
  });
  expect(created.status).toBe(409);
  expect(createSession).not.toHaveBeenCalled();
  expect(shells).not.toHaveBeenCalled();
});

it('keeps the existing terminal route available outside the installed native service', async () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'web');
  vi.stubEnv('NOTNATIVE_HARNESS', 'mock');
  const shells = vi.fn(() => []);
  const app = createApp({ terminal: { shells } as unknown as TerminalRuntime });
  expect(nativeServiceTerminalUnavailable()).toBe(false);
  const listed = await app.request('/api/terminal/shells');
  expect(listed.status).toBe(200);
  expect(shells).toHaveBeenCalledOnce();
});
