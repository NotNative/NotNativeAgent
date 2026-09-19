// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel test fakes: a stream/child pair honoring the TunnelChildLike
 * contract, and a spawn-deps factory with adjustable filesystem/binaries.
 * Pushing into a stream synchronously invokes the registered listeners —
 * starters attach listeners before their first await, so a synchronous
 * push after `const p = starter(...)` settles deterministically.
 */
import { createTunnelController, type TunnelControllerLike } from '../../lib/tunnels/tunnel-controller.ts';
import type { SpawnRequest, SyncRunResult, TunnelChildLike, TunnelSpawnDeps } from '../../lib/tunnels/tunnel-spawn.ts';

export class FakeStream {
  private readonly listeners: ((chunk: Buffer | string) => void)[] = [];

  on(event: 'data', listener: (chunk: Buffer | string) => void): void {
    this.listeners.push(listener);
  }

  push(chunk: string, encoding: BufferEncoding = 'utf8'): void {
    const buffer = Buffer.from(chunk, encoding);
    for (const listener of [...this.listeners]) listener(buffer);
  }
}

export class FakeChild implements TunnelChildLike {
  killed = false;
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 4242;
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];

  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit' | 'error', listener: ((code: number | null, signal: string | null) => void) | ((error: Error) => void)): void {
    if (event === 'exit') this.exitListeners.push(listener as (code: number | null, signal: string | null) => void);
    else this.errorListeners.push(listener as (error: Error) => void);
  }

  kill(signal?: string): boolean {
    this.signalCode = signal ?? null;
    const wasKilled = this.killed;
    this.killed = true;
    return !wasKilled;
  }

  emitExit(code: number = 0, signal: string | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

export interface SpawnRecord {
  request: SpawnRequest;
  child: FakeChild;
}

export interface FakeDepIO {
  existsSet: Set<string>;
  readTextMap: Map<string, string>;
  sizeMap: Map<string, number>;
}

export interface FakeSpawnKit {
  deps: TunnelSpawnDeps;
  records: SpawnRecord[];
  removed: string[];
  written: Array<{ path: string; data: string; mode: number | undefined }>;
  io: FakeDepIO;
  tempCounter: { n: number };
}

export function fakeSpawnDeps(root: string, seed: {
  spawn?: (request: SpawnRequest) => FakeChild;
  spawnSync?: (command: string, args: readonly string[]) => SyncRunResult;
} = {}): FakeSpawnKit {
  const records: SpawnRecord[] = [];
  const removed: string[] = [];
  const written: FakeSpawnKit['written'] = [];
  const io: FakeDepIO = { existsSet: new Set(), readTextMap: new Map(), sizeMap: new Map() };
  const tempCounter = { n: 0 };
  const deps: TunnelSpawnDeps = {
    spawn: (request) => {
      const child = seed.spawn ? seed.spawn(request) : new FakeChild();
      records.push({ request, child });
      return child;
    },
    spawnSync: seed.spawnSync ?? (() => ({ status: 0, stdout: 'cloudflared 2024.10.1\n', stderr: '' })),
    mkdtempSync: (prefix) => `${root}/temps/${prefix}${tempCounter.n++}`,
    rmSync: (path) => {
      removed.push(path);
      for (const key of [...io.existsSet]) if (key === path || key.startsWith(path)) io.existsSet.delete(key);
    },
    writeFileSync: (path, data, options) => {
      written.push({ path, data, mode: options?.mode });
      io.existsSet.add(path);
    },
    ensureDir: (path) => {
      io.existsSet.add(path);
    },
    exists: (path) => io.existsSet.has(path.replace(/\\/gu, '/')) || io.existsSet.has(path),
    statIsFile: (path) => (io.existsSet.has(path.replace(/\\/gu, '/')) || io.existsSet.has(path) ? true : null),
    fileSize: (path) => io.sizeMap.get(path.replace(/\\/gu, '/')) ?? io.sizeMap.get(path) ?? null,
    chmod: () => undefined,
    readText: (path) => io.readTextMap.get(path.replace(/\\/gu, '/')) ?? io.readTextMap.get(path) ?? '',
    env: (name) => (name === 'LOCALAPPDATA' ? `${root}/local` : undefined),
    platform: () => process.platform,
    searchPath: () => [`${root}/bin`],
    executableExtensions: () => process.platform === 'win32' ? ['', '.exe'] : [''],
  };
  return { deps, records, removed, written, io, tempCounter };
}

/** Adds `name` as an (executable) file under `<root>/bin`. */
export function plantBinary(kit: FakeSpawnKit, name: string): void {
  kit.io.existsSet.add(`${kit.deps.searchPath()[0]}/${name}`);
}

export function controllerFor(provider: 'cloudflare' | 'ngrok', mode: 'quick' | 'managed-local' | 'managed-remote', child: FakeChild, publicUrl: string, meta: { resolvedHostname?: string | null; effectiveConfigPath?: string | null; cleanup?: () => void } = {}): TunnelControllerLike {
  return createTunnelController({
    provider,
    mode,
    child,
    publicUrl,
    resolvedHostname: meta.resolvedHostname ?? null,
    effectiveConfigPath: meta.effectiveConfigPath ?? null,
    onCleanup: meta.cleanup,
  });
}
