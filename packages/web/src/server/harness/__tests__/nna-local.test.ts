import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { guardLocalNnaHarness, resolveNnaCommand, startLocalNnaHarness, startLocalNnaHarnessWithRetry } from '../nna-local.ts';

const token = 't'.repeat(32);

function child() {
  const value = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  return value as any;
}

function ready(endpoint = 'http://127.0.0.1:4812') {
  return `${JSON.stringify({ type: 'ready', protocol: '1.0', endpoint, instance_id: 'instance-1', token })}\n`;
}

describe('managed local NNA launcher', () => {
  it('discovers the installed Windows NNA runtime without relying on PATH', async () => {
    const accessed: string[] = [];
    const resolved = await resolveNnaCommand({
      platform: 'win32', environment: { LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local' },
      readFile: async () => JSON.stringify({ product: 'NotNativeAgent', node: 'C:\\Program Files\\nodejs\\node.exe', install_root: 'C:\\Users\\operator\\AppData\\Local\\NotNativeAgent', data_root: 'D:\\NNA Data' }),
      access: async (value) => { accessed.push(String(value)); },
    });
    expect(resolved).toEqual({ command: 'C:\\Program Files\\nodejs\\node.exe', arguments: ['C:\\Users\\operator\\AppData\\Local\\NotNativeAgent\\installed\\src\\cli.js'], dataRoot: 'D:\\NNA Data' });
    expect(accessed).toHaveLength(2);
  });

  it('uses explicit or portable commands when an installed descriptor is unavailable', async () => {
    await expect(resolveNnaCommand({ command: 'D:\\tooling\\nna.exe', platform: 'win32' })).resolves.toEqual({ command: 'D:\\tooling\\nna.exe', arguments: [] });
    await expect(resolveNnaCommand({ platform: 'win32', readFile: async () => { throw new Error('missing'); } })).resolves.toEqual({ command: 'nna', arguments: [] });
  });

  it('rejects a descriptor that is not an NNA installation', async () => {
    await expect(resolveNnaCommand({
      platform: 'win32', readFile: async () => JSON.stringify({ product: 'SomethingElse', node: 'C:\\node.exe', install_root: 'C:\\tooling' }),
    })).resolves.toEqual({ command: 'nna', arguments: [] });
  });

  it('does not use an installed descriptor without an absolute data root', async () => {
    await expect(resolveNnaCommand({
      platform: 'win32', readFile: async () => JSON.stringify({ product: 'NotNativeAgent', node: 'C:\\node.exe', install_root: 'C:\\tooling', data_root: 'relative' }),
    })).resolves.toEqual({ command: 'nna', arguments: [] });
  });

  it('accepts one valid loopback readiness record and mints fresh server principals', async () => {
    const process = child();
    const spawnChild = vi.fn((_command: string, _args: string[]) => process);
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild });
    expect(spawnChild.mock.calls[0]?.[1]).toEqual(['nnd', 'serve']);
    process.stdout.write(ready());
    const harness = await promise;
    expect(harness.endpoint).toBe('http://127.0.0.1:4812');
    expect(harness.token).toBe(token);
    const first = JSON.parse(Buffer.from(harness.principal(), 'base64url').toString('utf8'));
    const second = JSON.parse(Buffer.from(harness.principal(), 'base64url').toString('utf8'));
    expect(first.workspace_ids).toEqual(['local']);
    expect(first.permissions).toContain('nnd.steer');
    expect(first.permissions).toContain('provider.read');
    expect(first.permissions).toContain('provider.discover');
    expect(first.permissions).toContain('provider.test');
    expect(first.permissions).toContain('provider.route.manage');
    expect(first.permissions).toContain('provider.route.activate');
    expect(first.permissions).not.toContain('provider.manage');
    expect(first.request_id).not.toBe(second.request_id);
    process.emit('exit', 1);
    expect(harness.isRunning()).toBe(false);
  });

  it('passes installed NNA data_root to the direct Node child as NNA_HOME', async () => {
    const process = child();
    const spawnChild = vi.fn((_command: string, _args: string[], _options: unknown) => process);
    const promise = startLocalNnaHarness({ command: 'C:\\node.exe', commandArguments: ['C:\\nna\\installed\\src\\cli.js'], dataRoot: 'D:\\NNA Data', workspaceId: 'local', spawnChild });
    expect(spawnChild.mock.calls[0]?.[1]).toEqual(['C:\\nna\\installed\\src\\cli.js', 'nnd', 'serve']);
    expect(spawnChild.mock.calls[0]?.[2]).toMatchObject({ env: { NNA_HOME: 'D:\\NNA Data' } });
    process.stdout.write(ready());
    const harness = await promise;
    harness.dispose();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('passes only a validated loopback callback capability to the owned child', async () => {
    const process = child();
    const spawnChild = vi.fn((_command: string, _args: string[], _options: unknown) => process);
    const browserCallback = { url: 'http://127.0.0.1:4172/api/browser-control/request', token };
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', browserCallback, spawnChild });
    expect(spawnChild.mock.calls[0]?.[2]).toMatchObject({ env: {
      NNA_NND_BROWSER_URL: browserCallback.url, NNA_NND_BROWSER_TOKEN: token,
    } });
    process.stdout.write(ready());
    (await promise).dispose();
    await expect(startLocalNnaHarness({ command: 'nna', workspaceId: 'local',
      browserCallback: { url: 'http://evil.example/api/browser-control/request', token }, spawnChild })).rejects.toThrow(/callback/u);
    expect(spawnChild).toHaveBeenCalledOnce();
  });

  it('does not inherit a stale browser callback when this launch has no bridge', async () => {
    const previousUrl = process.env.NNA_NND_BROWSER_URL;
    const previousToken = process.env.NNA_NND_BROWSER_TOKEN;
    process.env.NNA_NND_BROWSER_URL = 'http://127.0.0.1:4172/api/browser-control/request';
    process.env.NNA_NND_BROWSER_TOKEN = token;
    try {
      const launched = child();
      const spawnChild = vi.fn((_command: string, _args: string[], _options: unknown) => launched);
      const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild });
      const childEnv = (spawnChild.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv }).env;
      expect(childEnv.NNA_NND_BROWSER_URL).toBeUndefined();
      expect(childEnv.NNA_NND_BROWSER_TOKEN).toBeUndefined();
      launched.stdout.write(ready());
      (await promise).dispose();
    } finally {
      if (previousUrl === undefined) delete process.env.NNA_NND_BROWSER_URL;
      else process.env.NNA_NND_BROWSER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.NNA_NND_BROWSER_TOKEN;
      else process.env.NNA_NND_BROWSER_TOKEN = previousToken;
    }
  });

  it.each(['http://evil.example:4812', 'http://localhost:4812', 'http://[::1]:4812', 'https://127.0.0.1:4812', 'http://127.0.0.1:0', 'http://127.0.0.1:4812/path'])('rejects unsafe readiness endpoint %s', async (endpoint: string) => {
    const process = child();
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild: () => process });
    process.stdout.write(ready(endpoint));
    await expect(promise).rejects.toThrow(/unsafe/u);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('rejects a readiness credential that Node cannot safely forward as an HTTP header', async () => {
    const process = child();
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild: () => process });
    process.stdout.write(`${JSON.stringify({ type: 'ready', protocol: '1.0', endpoint: 'http://127.0.0.1:4812', instance_id: 'instance-1', token: 'é'.repeat(32) })}\n`);
    await expect(promise).rejects.toThrow(/unsafe/u);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('does not expose child stderr and terminates a child that exits before readiness', async () => {
    const process = child();
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild: () => process });
    process.stderr.write('token=top-secret');
    process.emit('exit', 1);
    await expect(promise).rejects.toThrow('NNA local harness exited before readiness');
    await expect(promise).rejects.not.toThrow('top-secret');
  });

  it('retries one early child exit and accepts readiness from the replacement', async () => {
    const first = child();
    const second = child();
    const spawnChild = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const promise = startLocalNnaHarnessWithRetry({ command: 'nna', workspaceId: 'local', spawnChild });
    first.stderr.write('nna: internal_failure\n');
    first.emit('exit', 2);
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledTimes(2));
    second.stdout.write(ready());
    const harness = await promise;
    expect(harness.endpoint).toBe('http://127.0.0.1:4812');
    harness.dispose();
  });

  it('stops after a second early exit and reports only a sanitized NNA failure code', async () => {
    const first = child();
    const second = child();
    const spawnChild = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const promise = startLocalNnaHarnessWithRetry({ command: 'nna', workspaceId: 'local', spawnChild });
    first.emit('exit', 2);
    await vi.waitFor(() => expect(spawnChild).toHaveBeenCalledTimes(2));
    second.stderr.write('token=top-secret\nnna: package_not_registered\n');
    second.emit('exit', 2);
    await expect(promise).rejects.toThrow('NNA local harness exited before readiness (package_not_registered)');
    await expect(promise).rejects.not.toThrow('top-secret');
    expect(spawnChild).toHaveBeenCalledTimes(2);
  });

  it('does not crash the host on a child error after readiness', async () => {
    const process = child();
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild: () => process });
    process.stdout.write(ready());
    const harness = await promise;
    expect(() => process.emit('error', new Error('kill failed; token=top-secret'))).not.toThrow();
    expect(() => process.emit('error', new Error('second shutdown error'))).not.toThrow();
    expect(harness.isRunning()).toBe(false);
  });

  it('returns an explicit unavailable response after an owned child stops', async () => {
    const result = guardLocalNnaHarness({ handle: vi.fn() }, { isRunning: () => false });
    const response = await result.handle(new Request('http://nnd.local/api/session'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: 'NNA local harness stopped' } });
  });
});
