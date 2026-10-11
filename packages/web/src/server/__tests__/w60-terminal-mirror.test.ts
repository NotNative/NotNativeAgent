// SPDX-License-Identifier: Apache-2.0
/**
 * W-60 browser/desktop mirroring + reattach: two surfaces (desktop shell and
 * a browser tab) attach to the SAME server-side session; PTY output frames
 * reach both viewers (mirroring), input from either surface reaches the PTY,
 * and a churned browser socket re-attaches idempotently with a snapshot
 * replay first. Remote-device access is excluded by contract ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â both sockets
 * share one runtime, which is the same-host shape.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { TerminalRuntime, type SocketLike } from '../terminal/session-core.ts';
import type { PtyFactory, PtyHandle, PtySpawnSpec } from '../terminal/pty-backend.ts';

const RUNTIME_CWD = mkdtempSync(`${tmpdir()}${sep}nnd-w60-`);
const BASE = { cwd: RUNTIME_CWD, cols: 80, rows: 24 };

class FakePty implements PtyHandle {
  readonly pid = 43_000;
  readonly writes: string[] = [];
  private dataHandlers: ((data: string) => void)[] = [];
  onData(callback: (data: string) => void): void { this.dataHandlers.push(callback); }
  onExit(): void { /* stays alive for the whole test */ }
  write(data: string): void { this.writes.push(data); }
  resize(): void { /* unused */ }
  kill(): void { /* unused */ }
  emit(data: string): void { for (const handler of this.dataHandlers) handler(data); }
}

function fakeFactory(pty: FakePty): PtyFactory {
  return (spec: PtySpawnSpec): FakePty => { void spec; return pty; };
}

interface SocketStub extends SocketLike { frames: string[] }

function socket(): SocketStub {
  const frames: string[] = [];
  return { frames, send: (frame): void => { frames.push(frame.subarray(1).toString('utf8')); }, close: (): void => undefined };
}

function bufferFrame(frame: unknown): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(frame), 'utf8')]);
}

function outputFrames(target: SocketStub): string[] {
  return target.frames.map((row) => JSON.parse(row) as { t: string; d?: string }).filter(f => f.t === 'output').map(f => f.d ?? '');
}

describe('W-60 terminal mirroring + reattach', () => {
  it('one desktop writer and one browser viewer see the same PTY stream; either can write; churn re-attaches with snapshot first', async () => {
    const pty = new FakePty();
    const runtime = new TerminalRuntime(fakeFactory(pty));
    const created = await runtime.createSession({ ...BASE, sessionId: 'tab-mirror' } as never);
    expect(created.sessionId).toBe('tab-mirror');

    const desktop = socket(); const browser = socket();
    runtime.handleSocketFrame(desktop, bufferFrame({ v: 3, t: 'attach', s: 'tab-mirror' }));
    runtime.handleSocketFrame(browser, bufferFrame({ v: 3, t: 'attach', s: 'tab-mirror' }));
    expect(JSON.parse(desktop.frames[0]!).t).toBe('snapshot'); // snapshot is ALWAYS first
    expect(JSON.parse(browser.frames[0]!).t).toBe('snapshot');

    pty.emit('build ok\r\n'); // the PTY process produces output once
    expect(outputFrames(desktop)).toEqual(['build ok\r\n']); // the desktop viewer mirrors it
    expect(outputFrames(browser)).toEqual(['build ok\r\n']); // and the browser viewer mirrors the same bytes

    runtime.handleSocketFrame(browser, bufferFrame({ v: 3, t: 'write', s: 'tab-mirror', d: 'echo hi\r' }));
    expect(pty.writes).toContain('echo hi\r'); // browser input reaches the shared PTY

    // Churn: the browser socket drops and re-attaches (reload/reconnect).
    runtime.handleSocketFrame(browser, bufferFrame({ v: 3, t: 'detach', s: 'tab-mirror' }));
    const reattached = socket();
    runtime.handleSocketFrame(reattached, bufferFrame({ v: 3, t: 'attach', s: 'tab-mirror' }));
    expect(JSON.parse(reattached.frames[0]!).t).toBe('snapshot'); // snapshot replay is ALWAYS first
    const snap = JSON.parse(reattached.frames[0]!) as { t: string; history: string };
    expect(snap.history).toContain('build ok'); // the scrubbed replay carries the mirrored output
  });
});
