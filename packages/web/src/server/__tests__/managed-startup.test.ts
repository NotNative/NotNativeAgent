import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dispose: vi.fn(), serve: vi.fn(), register: vi.fn(), attach: vi.fn() }));

vi.mock('../env.ts', () => ({ ENV: {
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
    const server = Object.assign(new EventEmitter(), { listening: false });
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
