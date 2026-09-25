// SPDX-License-Identifier: Apache-2.0
/** Owns the local NNA integration child used by the packaged desktop default. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { harnessError, type HarnessAdapter } from './adapter.ts';

const READY_LIMIT = 16 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
// NNA creates base64url tokens.  Keep this ASCII-only at the readiness
// boundary so it is always safe to place in a Node HTTP header later.
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;

export interface LocalNnaLaunchOptions {
  command: string;
  workspaceId: string;
  startupTimeoutMs?: number;
  spawnChild?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
}

export interface LocalNnaHarness {
  endpoint: string;
  token: string;
  principal(): string;
  isRunning(): boolean;
  dispose(): void;
}

/** Starts NNA and accepts only its one-line, loopback readiness protocol. */
export function startLocalNnaHarness(options: LocalNnaLaunchOptions): Promise<LocalNnaHarness> {
  if (!options.command.trim()) return Promise.reject(new Error('NNA command is required'));
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(options.workspaceId)) return Promise.reject(new Error('NNA workspace id is invalid'));
  const child = (options.spawnChild ?? spawn)(options.command, ['integration', 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  let running = true;
  let settled = false;
  child.once('exit', () => { running = false; });
  // Stderr is deliberately consumed so a noisy child cannot block, but no
  // diagnostic content is reflected into browser responses or startup errors.
  child.stderr.resume();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail('NNA local harness did not become ready'), options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    let buffered = '';
    const onError = (): void => fail('NNA local harness could not start');
    const onPrematureExit = (): void => fail('NNA local harness exited before readiness');
    const onData = (part: Buffer | string): void => {
      if (settled) return;
      buffered += String(part);
      if (Buffer.byteLength(buffered, 'utf8') > READY_LIMIT) return fail('NNA local harness readiness is too large');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      if (buffered.slice(newline + 1).trim()) return fail('NNA local harness emitted unexpected stdout');
      let ready: { endpoint?: unknown; token?: unknown; type?: unknown; protocol?: unknown; instance_id?: unknown };
      try { ready = JSON.parse(line) as typeof ready; } catch { return fail('NNA local harness readiness is invalid'); }
      if (ready.type !== 'ready' || ready.protocol !== '1.0' || typeof ready.instance_id !== 'string') return fail('NNA local harness readiness is incompatible');
      if (typeof ready.endpoint !== 'string' || !isLoopbackOrigin(ready.endpoint) || typeof ready.token !== 'string' || !TOKEN.test(ready.token)) return fail('NNA local harness readiness is unsafe');
      settled = true; clean();
      resolve({ endpoint: ready.endpoint, token: ready.token, isRunning: () => running, dispose: stop,
        principal: () => mintLocalPrincipal(options.workspaceId) });
    };
    const clean = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onPrematureExit);
    };
    const stop = (): void => { if (running) { running = false; child.kill(); } };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true; clean(); stop(); reject(new Error(message));
    };
    child.once('error', onError);
    child.once('exit', onPrematureExit);
    child.stdout.on('data', onData);
  });
}

/** Wrapper gives an explicit harness-down result rather than an empty projection. */
export function guardLocalNnaHarness(adapter: HarnessAdapter, harness: Pick<LocalNnaHarness, 'isRunning'>): HarnessAdapter {
  return { handle: (request) => harness.isRunning() ? adapter.handle(request) : Promise.resolve(harnessError('NNA local harness stopped', 502)) };
}

function isLoopbackOrigin(value: string): boolean {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return false; }
  return endpoint.protocol === 'http:' && !endpoint.username && !endpoint.password
    && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash
    && ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(endpoint.hostname);
}

function mintLocalPrincipal(workspaceId: string): string {
  const now = new Date().toISOString();
  return Buffer.from(JSON.stringify({
    subject_id: 'nnd-local-operator', platform_role: 'operator',
    permissions: ['nnd.read', 'nnd.session.create', 'nnd.session.submit', 'nnd.steer'],
    workspace_ids: [workspaceId], group_ids: [], trace_id: randomUUID(), request_id: randomUUID(), issued_at: now,
  }), 'utf8').toString('base64url');
}
