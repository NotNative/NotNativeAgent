// SPDX-License-Identifier: Apache-2.0
/**
 * PTY backend (doc 07 section 4.3): node-pty with ConPTY on Windows
 * (`useConpty: true`); spawn options exactly as documented (xterm-256color
 * name, cwd, env); data/exit listeners are wired by the RUNTIME in the same
 * synchronous turn the handle arrives (backend invariant). The runtime owns
 * process-group kills; this adapter exposes the documented handle shape.
 */
import { createRequire } from 'node:module';
import type { IPty } from 'node-pty';

interface NodePtyModule {
  spawn: (file: string, args: readonly string[], options: Record<string, unknown>) => IPty;
}

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Graceful kill per platform (ConPTY close on Windows; caller escalates). */
  kill(): void;
  pid: number;
}

export interface PtyEvents {
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode?: number; signal?: number }) => void): void;
}

export interface PtySpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export type PtyFactory = (spec: PtySpawnSpec) => PtyHandle & PtyEvents;

export function createNodePtyFactory(): PtyFactory {
  // node-pty is a CJS-only native module; the package is ESM ("type":
  // "module", Node strip-only execution) so `createRequire` is the only
  // caller-side bridge. Loaded once at factory construction (server boot).
  const pty = createRequire(import.meta.url)('node-pty') as NodePtyModule;
  return (spec: PtySpawnSpec): PtyHandle & PtyEvents => {
    const child = pty.spawn(spec.executable, spec.args, {
      name: 'xterm-256color',
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
      useConpty: process.platform === 'win32',
    });
    return {
      pid: child.pid,
      write: (data: string): void => { child.write(data); },
      resize: (cols: number, rows: number): void => { child.resize(cols, rows); },
      kill: (): void => { child.kill(); },
      onData: (callback: (data: string) => void): void => { child.onData(callback); },
      onExit: (callback: (event: { exitCode?: number; signal?: number }) => void): void => {
        child.onExit(({ exitCode, signal }) => callback({ exitCode, signal }));
      },
    };
  };
}
