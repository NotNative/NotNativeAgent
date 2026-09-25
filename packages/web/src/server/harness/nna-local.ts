// SPDX-License-Identifier: Apache-2.0
/** Owns the local NNA integration child used by the packaged desktop default. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harnessError, type HarnessAdapter } from './adapter.ts';

const READY_LIMIT = 16 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
// NNA creates base64url tokens.  Keep this ASCII-only at the readiness
// boundary so it is always safe to place in a Node HTTP header later.
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;

export interface LocalNnaLaunchOptions {
  command: string;
  commandArguments?: string[];
  dataRoot?: string;
  workspaceId: string;
  startupTimeoutMs?: number;
  spawnChild?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
}

export interface NnaCommandResolutionOptions {
  command?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  access?: (path: string) => Promise<unknown>;
}

export interface ResolvedNnaCommand {
  command: string;
  arguments: string[];
  dataRoot?: string;
}

/** Resolves a co-installed Windows NNA without relying on the user's PATH. */
export async function resolveNnaCommand(options: NnaCommandResolutionOptions = {}): Promise<ResolvedNnaCommand> {
  const explicit = options.command?.trim();
  if (explicit) return { command: explicit, arguments: [] };
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'nna', arguments: [] };
  // Use the requested platform's path rules even in cross-platform tests. More
  // importantly, do not let a POSIX host misclassify a recorded Windows path.
  const platformPath = path.win32;
  const environment = options.environment ?? process.env;
  const localAppData = environment.LOCALAPPDATA ?? platformPath.join(options.homeDirectory ?? os.homedir(), 'AppData', 'Local');
  const descriptorPath = platformPath.join(localAppData, 'NotNativeAgent', 'install.json');
  try {
    const source = await (options.readFile ?? readFile)(descriptorPath, 'utf8');
    const descriptor = JSON.parse(source) as { product?: unknown; node?: unknown; install_root?: unknown; data_root?: unknown };
    if (descriptor.product !== 'NotNativeAgent' || typeof descriptor.node !== 'string' || !platformPath.isAbsolute(descriptor.node)
      || typeof descriptor.install_root !== 'string' || !platformPath.isAbsolute(descriptor.install_root)
      || typeof descriptor.data_root !== 'string' || !platformPath.isAbsolute(descriptor.data_root)) throw new Error('invalid');
    const cli = platformPath.join(descriptor.install_root, 'installed', 'src', 'cli.js');
    await (options.access ?? access)(descriptor.node);
    await (options.access ?? access)(cli);
    return { command: descriptor.node, arguments: [cli], dataRoot: descriptor.data_root };
  } catch {
    // A PATH binary remains a valid deployment path for portable/nonstandard installs.
    return { command: 'nna', arguments: [] };
  }
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
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.spawnChild ?? spawn)(options.command, [...(options.commandArguments ?? []), 'nnd', 'serve'], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      ...(options.dataRoot ? { env: { ...process.env, NNA_HOME: options.dataRoot } } : {}),
    }) as ChildProcessWithoutNullStreams;
  } catch {
    return Promise.reject(new Error('NNA local harness could not start'));
  }
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
      // NNA's stdout is protocol-only, but continue draining it after the
      // readiness frame so an accidental diagnostic cannot stall its child.
      child.stdout.resume();
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
    // `localhost` is not a safe authority boundary: hosts/DNS configuration
    // can map it to a remote address. The NNA readiness protocol mandates
    // this exact numeric loopback host.
    && endpoint.hostname === '127.0.0.1' && endpoint.port !== '' && Number(endpoint.port) > 0;
}

function mintLocalPrincipal(workspaceId: string): string {
  const now = new Date().toISOString();
  return Buffer.from(JSON.stringify({
    subject_id: 'nnd-local-operator', platform_role: 'operator',
    permissions: ['nnd.read', 'nnd.session.create', 'nnd.session.submit', 'nnd.steer'],
    workspace_ids: [workspaceId], group_ids: [], trace_id: randomUUID(), request_id: randomUUID(), issued_at: now,
  }), 'utf8').toString('base64url');
}
