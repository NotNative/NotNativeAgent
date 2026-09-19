// SPDX-License-Identifier: Apache-2.0
/**
 * Process plumbing for tunnel providers (doc 08 §4.3): executable presence
 * checks (PATH/PATHEXT scan — the Windows Store alias dir
 * `%LOCALAPPDATA%\Microsoft\WindowsApps` is an extra search entry, so one
 * pass covers execution aliases), version probes, and the structural child
 * contract every starter consumes. The real binding is `realSpawnDeps()`;
 * tests inject fakes instead of shelling out.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';

export interface TunnelChildStreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void;
}

export interface TunnelChildLike {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: string | undefined): boolean;
  stdout: TunnelChildStreamLike | null;
  stderr: TunnelChildStreamLike | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface SyncRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: { code?: string | number | undefined };
}

export interface SpawnRequest {
  command: string;
  args: readonly string[];
  env?: Record<string, string | undefined> | undefined;
  windowsHide?: boolean | undefined;
  stdio: readonly ('ignore' | 'pipe')[];
}

export interface TunnelSpawnDeps {
  spawn: (request: SpawnRequest) => TunnelChildLike;
  spawnSync: (command: string, args: readonly string[]) => SyncRunResult;
  mkdtempSync: (prefix: string) => string;
  rmSync: (path: string, options?: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number }) => void;
  writeFileSync: (path: string, data: string, options?: { mode?: number }) => void;
  ensureDir: (path: string) => void;
  exists: (path: string) => boolean;
  statIsFile: (path: string) => boolean | null;
  fileSize: (path: string) => number | null;
  chmod: (path: string, mode: number) => void;
  readText: (path: string) => string;
  env: (name: string) => string | undefined;
  platform: () => NodeJS.Platform;
  searchPath: () => readonly string[];
  executableExtensions: () => readonly string[];
}

export function realSpawnDeps(): TunnelSpawnDeps {
  return {
    spawn: (request) => spawn(request.command, request.args, {
      stdio: request.stdio as ('pipe' | 'ignore')[],
      env: request.env === undefined ? undefined : (request.env as NodeJS.ProcessEnv),
      windowsHide: request.windowsHide === undefined ? true : request.windowsHide,
    }) as unknown as TunnelChildLike,
    spawnSync: (command, args) => spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 }) as SyncRunResult,
    mkdtempSync: (prefix) => mkdtempSync(prefix),
    rmSync: (path, options) => rmSync(path, {
      recursive: options?.recursive === true,
      force: options?.force === true,
      maxRetries: options?.maxRetries ?? 3,
      retryDelay: options?.retryDelay ?? 100,
    }),
    writeFileSync: (path, data, options) => writeFileSync(path, data, options?.mode === undefined ? {} : { mode: options.mode }),
    ensureDir: (path) => mkdirSync(path, { recursive: true }),
    exists: (path) => existsSync(path),
    statIsFile: (path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return null;
      }
    },
    fileSize: (path) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    },
    chmod: (path, mode) => chmodSync(path, mode),
    readText: (path) => readFileSync(path, 'utf8'),
    env: (name) => process.env[name],
    platform: () => process.platform,
    searchPath: () => {
      const raw = process.env.PATH ?? '';
      return raw.split(/[;/]/u).filter((entry) => entry !== '');
    },
    executableExtensions: () => {
      if (process.platform !== 'win32') return [''];
      // .bat/.cmd/.com are script hosts that modern Node refuses to spawn
      // without a shell (EINVAL) — never resolved as launch targets.
      const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter((entry) => entry !== '' && ['.BAT', '.CMD', '.COM'].every((blocked) => entry.toUpperCase() !== blocked));
      return ['', ...pathExt];
    },
  };
}

let injectedDeps: TunnelSpawnDeps | null = null;

/** Test seam: one holder serves route probes AND the service start path so
 * fakes stay consistent (presence probes, starters, profile reads). */
export function setTunnelSpawnDepsForTests(deps: TunnelSpawnDeps | null): void {
  injectedDeps = deps;
}

export function tunnelSpawnDeps(): TunnelSpawnDeps {
  return injectedDeps ?? realSpawnDeps();
}

/** §4.3 temp-dir hygiene: bounded retries (Windows holds the dir open
 * while the child lives; the exit event re-fires) and a swallowed error —
 * cleanup is cosmetic, never a crash path (review P2). */
export function rmTempDir(deps: TunnelSpawnDeps, path: string): void {
  try {
    deps.rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // leftover temp dirs are benign; never fail a stop/shutdown for one
  }
}

/** PATH/PATHEXT scan (§4.3 "executable search incl. Windows Store aliases").
 * Returns an absolute candidate path, or null when nothing matches. */
export function resolveExecutableLaunchTarget(command: string, deps: TunnelSpawnDeps, extraSearch?: readonly string[]): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return deps.statIsFile(command) === true ? command : null;
  }
  const entries = [...(extraSearch ?? []), ...deps.searchPath()];
  for (const entry of entries) {
    for (const extension of deps.executableExtensions()) {
      const candidate = `${entry}${entry.endsWith('\\') || entry.endsWith('/') ? '' : '/'}${command}${extension}`;
      if (deps.statIsFile(candidate) === true) return candidate;
    }
  }
  return null;
}

/** §4.3 presence probe: PATH resolution + `--version` (Windows Store
 * aliases ride the LOCALAPPDATA WindowsApps dir as an extra entry). */
export function checkExecutable(command: string, deps: TunnelSpawnDeps): { available: boolean; version: string | null; target: string | null } {
  const home = deps.env('LOCALAPPDATA');
  const extra = deps.platform() === 'win32' && home !== undefined && home !== ''
    ? [`${home}\\Microsoft\\WindowsApps`]
    : [];
  const target = resolveExecutableLaunchTarget(command, deps, extra);
  if (target === null) return { available: false, version: null, target: null };
  const probe = deps.spawnSync(target, ['--version']);
  if (probe.status !== 0 || probe.error !== undefined) return { available: false, version: null, target };
  return { available: true, version: probeVersionLine(probe), target };
}

/** First non-empty stdout/stderr line of a `--version` probe or result. */
export function probeVersionLine(result: SyncRunResult): string | null {
  for (const stream of [result.stdout, result.stderr]) {
    for (const line of stream.split('\n')) {
      const candidate = line.trim();
      if (candidate !== '') return candidate;
    }
  }
  return null;
}
