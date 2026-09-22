// SPDX-License-Identifier: Apache-2.0
/**
 * RealTerminalApi — RuntimeAPIs.terminal over the terminal lib (SLICE-B v1):
 * lib/server-api REST (create/resize/close/shells) + the §6.1 transport
 * singleton for wire frames, projected to the RuntimeAPIs TerminalStreamEvent
 * contract (lib/api/types.ts). The desktop terminal runtime keeps its own
 * adapter; this one backs the web shell seam (createWebAPIs).
 */
import type { TerminalApi, TerminalStreamEvent, TerminalSubscription } from './types.ts';
import {
  closeTerminalSession, createTerminalSession, listTerminalShells,
  resizeTerminalSession, type CreateTerminalRequest,
} from '../server-api.ts';
import { getTerminalTransport } from '../terminal/transport-singleton.ts';
import type { TerminalEventFrame } from '../terminal/wire.ts';

/** Map a wire frame to the RuntimeAPIs stream contract: snapshot replaces
 * the buffer at its PTY size (restarted → blank history), output appends
 * (replay-safe `r` when present), exit/reconnect are control planes. Error
 * frames are transport-internal: connect() routes them to onError. */
export function wireFrameToStreamEvent(frame: TerminalEventFrame): TerminalStreamEvent | null {
  if (frame.t === 'snapshot' || frame.t === 'restarted') {
    if (frame.t === 'restarted') return { type: 'snapshot', sequence: frame.q, data: '' };
    const wireStatus = frame.status === 'reconnecting' ? 'running' : frame.status;
    const base: {
      type: 'snapshot';
      sequence: number;
      data: string;
      cols: number;
      rows: number;
      status: 'running' | 'exited' | 'error';
      exitCode?: number;
      signal?: number | null;
    } = {
      type: 'snapshot',
      sequence: frame.q,
      data: frame.history,
      cols: frame.cols,
      rows: frame.rows,
      status: wireStatus === 'exited' ? 'exited' : wireStatus === 'error' ? 'error' : 'running',
    };
    if (frame.exitCode !== undefined) return { ...base, exitCode: frame.exitCode, signal: frame.signal ?? null };
    return base;
  }
  if (frame.t === 'output') return { type: 'data', sequence: frame.q, data: frame.r ?? frame.d };
  if (frame.t === 'exit') return { type: 'exit', exitCode: frame.exitCode, signal: frame.signal ?? null, status: 'exited' };
  if (frame.t === 'reconnecting') return { type: 'reconnecting', attempt: frame.attempt };
  return null; // hello/pong/error frames stay transport-internal
}

export function createRealTerminalApi(): TerminalApi {
  return {
    createSession: async (options) => {
      const request: CreateTerminalRequest = options.mode === 'command'
        ? { cwd: options.cwd, command: options.command }
        : {
            cwd: options.cwd,
            sessionId: options.sessionId,
            cols: options.cols,
            rows: options.rows,
            themeMode: options.themeMode,
            loginShell: options.loginShell,
            shell: options.shell,
          };
      const result = await createTerminalSession(request);
      if (!result.ok) throw new Error(result.error);
      return {
        sessionId: result.sessionId,
        cols: result.cols,
        rows: result.rows,
        status: result.status === 'exited' ? 'exited' : result.status === 'error' ? 'error' : 'running',
        mode: result.mode,
        purpose: result.purpose.type === 'terminal' ? { type: 'terminal' } : undefined,
      };
    },
    connect(sessionId, handlers): TerminalSubscription {
      const unsubscribe = getTerminalTransport().subscribe(sessionId, {
        onEvent: (frame) => {
          if (frame.t === 'error') {
            handlers.onError?.(new Error(frame.message ?? `terminal error${frame.code === undefined ? '' : ` (${frame.code})`}`));
            return;
          }
          const event = wireFrameToStreamEvent(frame);
          if (event !== null) handlers.onEvent(event);
        },
      });
      return { close: unsubscribe };
    },
    sendInput(sessionId, input) {
      getTerminalTransport().write(sessionId, input);
      return undefined;
    },
    async resize(options: { sessionId: string; cols: number; rows: number }) {
      await resizeTerminalSession(options.sessionId, options.cols, options.rows);
    },
    close: async (sessionId: string) => {
      await closeTerminalSession(sessionId);
    },
    async listShells() {
      const shells = await listTerminalShells();
      return shells.map((shell) => ({ id: shell.id, name: shell.name }));
    },
  };
}
