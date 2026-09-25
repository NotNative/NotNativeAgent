import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { guardLocalNnaHarness, startLocalNnaHarness } from '../nna-local.ts';

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
  it('accepts one valid loopback readiness record and mints fresh server principals', async () => {
    const process = child();
    const promise = startLocalNnaHarness({ command: 'nna', workspaceId: 'local', spawnChild: () => process });
    process.stdout.write(ready());
    const harness = await promise;
    expect(harness.endpoint).toBe('http://127.0.0.1:4812');
    expect(harness.token).toBe(token);
    const first = JSON.parse(Buffer.from(harness.principal(), 'base64url').toString('utf8'));
    const second = JSON.parse(Buffer.from(harness.principal(), 'base64url').toString('utf8'));
    expect(first.workspace_ids).toEqual(['local']);
    expect(first.permissions).toContain('nnd.steer');
    expect(first.request_id).not.toBe(second.request_id);
    process.emit('exit', 1);
    expect(harness.isRunning()).toBe(false);
  });

  it.each(['http://evil.example:4812', 'https://127.0.0.1:4812', 'http://127.0.0.1:4812/path'])('rejects unsafe readiness endpoint %s', async (endpoint) => {
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

  it('returns an explicit unavailable response after an owned child stops', async () => {
    const result = guardLocalNnaHarness({ handle: vi.fn() }, { isRunning: () => false });
    const response = await result.handle(new Request('http://nnd.local/api/session'));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { message: 'NNA local harness stopped' } });
  });
});
