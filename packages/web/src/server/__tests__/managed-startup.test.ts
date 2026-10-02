import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getUiAuthController, installNativeUiAuth, resetUiAuthForTests } from '../lib/auth/ui-auth.ts';
const nativeAuth = { installationId: 'nna_'+'a'.repeat(64), dataId: 'data_'+'b'.repeat(64), generation: 'generation-1', origin: 'http://127.0.0.1:4001' };
afterEach(() => resetUiAuthForTests());

const state = vi.hoisted(() => ({ dispose: vi.fn(), serve: vi.fn(), register: vi.fn(), attach: vi.fn() }));

vi.mock('../env.ts', () => ({ readEnvUiPassword: () => '', ENV: {
  harness: 'nna', nnaMode: 'managed', nnaCommand: '', nnaWorkspaceId: 'local', host: '127.0.0.1', port: 4001, dataDir: 'D:\\NND-test',
} }));
vi.mock('@hono/node-server', () => ({ serve: state.serve }));
vi.mock('../app.ts', () => ({ createApp: () => ({ fetch: vi.fn() }) }));
vi.mock('../terminal/bootstrap.ts', () => ({ createTerminalRuntime: () => ({ dispose: vi.fn(), startSweep: vi.fn() }) }));
vi.mock('../terminal/wire.ts', () => ({ attachTerminalWebsocket: state.attach }));
vi.mock('../harness/adapter.ts', () => ({ registerHarnessAdapter: state.register }));
vi.mock('../harness/nna.ts', () => ({ createNnaHarnessAdapter: () => ({ handle: vi.fn() }) }));
vi.mock('../harness/nna-local.ts', () => ({
  resolveNnaCommand: async () => ({ command: 'nna', arguments: [] }),
  startLocalNnaHarnessWithRetry: async () => ({ endpoint: 'http://127.0.0.1:4999', token: 't'.repeat(32), principal: () => 'principal', isRunning: () => true, dispose: state.dispose }),
  guardLocalNnaHarness: (adapter: unknown) => adapter,
}));

describe('managed server startup', () => {
  it('stops the owned NNA child when the HTTP port fails to bind asynchronously', async () => {
    state.dispose.mockClear();
    const server = Object.assign(new EventEmitter(), { listening: false, close: vi.fn() });
    state.serve.mockReturnValue(server);
    const { startServer } = await import('../index.ts');
    const boot = startServer();
    await vi.waitFor(() => expect(server.listenerCount('error')).toBeGreaterThan(0));
    server.emit('error', new Error('EADDRINUSE'));
    await expect(boot).rejects.toThrow('EADDRINUSE');
    expect(state.dispose).toHaveBeenCalledOnce();
  });

  it('closes the HTTP listener and owned NNA child if post-bind setup fails', async () => {
    state.dispose.mockClear();
    const close = vi.fn();
    const server = Object.assign(new EventEmitter(), { listening: false, close });
    state.serve.mockReturnValue(server);
    state.attach.mockImplementationOnce(() => { throw new Error('terminal wiring failed'); });
    const { startServer } = await import('../index.ts');
    const boot = startServer();
    await vi.waitFor(() => expect(server.listenerCount('listening')).toBeGreaterThan(0));
    server.emit('listening');
    await expect(boot).rejects.toThrow('terminal wiring failed');
    expect(close).toHaveBeenCalledOnce();
    expect(state.dispose).toHaveBeenCalledOnce();
  });
});

describe('native server auth lifecycle', () => {
  it('releases an exclusive bootstrap binding when the listener cannot bind', async () => {
    const server = Object.assign(new EventEmitter(), { listening: false, close: vi.fn() });
    state.serve.mockReturnValue(server);
    const { startServer } = await import('../index.ts');
    const boot = startServer({ nativeAuth });
    await vi.waitFor(() => expect(server.listenerCount('error')).toBeGreaterThan(0));
    expect(getUiAuthController().authRequired()).toBe(true);
    server.emit('error', new Error('EADDRINUSE'));
    await expect(boot).rejects.toThrow('EADDRINUSE');
    expect(() => installNativeUiAuth(nativeAuth)).not.toThrow();
  });
  it('retains closed auth until a failed post-bind listener confirms shutdown', async () => {
    const server = Object.assign(new EventEmitter(), { listening: false, close: vi.fn() });
    state.serve.mockReturnValue(server);
    state.attach.mockImplementationOnce(() => { throw new Error('terminal wiring failed'); });
    const { startServer } = await import('../index.ts');
    const boot = startServer({ nativeAuth });
    await vi.waitFor(() => expect(server.listenerCount('listening')).toBeGreaterThan(0));
    const handle = getUiAuthController().nativeHandle()!;
    server.listening = true;
    server.emit('listening');
    await expect(boot).rejects.toThrow('terminal wiring failed');
    expect(() => handle.issueTicket()).toThrow();
    expect(() => installNativeUiAuth(nativeAuth)).toThrow('already initialized');
    server.emit('close');
    expect(() => installNativeUiAuth(nativeAuth)).not.toThrow();
  });
});
