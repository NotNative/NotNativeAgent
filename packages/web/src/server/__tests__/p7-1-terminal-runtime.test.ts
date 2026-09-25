// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal runtime gates (doc 07 sections 3.3-3.5/4/7 Flow 1+6, invariants)
 * against a FAKE PTY (no real processes): create dedupe + action adoption +
 * pending single-flight + tombstone race + 20 cap; attach barrier exactly-
 * once; two sockets identical snapshots; sequence/replay (`r` present only
 * when the answerer scrubbed); write taxonomy (NOT_RUNNING, unknown
 * SESSION_NOT_FOUND); restart ordering; close/force-kill/idle/touch.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { TerminalRuntime, type SocketLike } from '../terminal/session-core.ts';
import type { PtyEvents, PtyFactory, PtyHandle, PtySpawnSpec } from '../terminal/pty-backend.ts';

const RUNTIME_CWD = mkdtempSync(`${tmpdir()}${sep}nnd-p71-`); // real directory: cwd stat must pass
const BASE = { cwd: RUNTIME_CWD, cols: 80, rows: 24 };

class FakePty implements PtyHandle, PtyEvents {
  readonly pid = 42_000 + Math.floor(Math.random() * 1000);
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;
  spawnSpec: PtySpawnSpec | null = null;
  private dataHandlers: ((data: string) => void)[] = [];
  private exitHandlers: ((event: { exitCode?: number; signal?: number }) => void)[] = [];

  onData(callback: (data: string) => void): void { this.dataHandlers.push(callback); }
  onExit(callback: (event: { exitCode?: number; signal?: number }) => void): void { this.exitHandlers.push(callback); }
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push([cols, rows]); }
  kill(): void { this.killed = true; }

  emit(data: string): void { for (const handler of this.dataHandlers) handler(data); }
  exit(exitCode = 0): void { for (const handler of this.exitHandlers) handler({ exitCode }); }
}

function fakeFactory(instances: FakePty[]): PtyFactory {
  return (spec: PtySpawnSpec): FakePty => {
    const pty = new FakePty();
    pty.spawnSpec = spec;
    instances.push(pty);
    return pty;
  };
}

interface SocketStub extends SocketLike { frames: string[] }

function socket(id: number): SocketStub {
  const frames: string[] = [];
  return {
    frames,
    send: (frame): void => { frames.push(frame.subarray(1).toString('utf8')); }, // strip the 0x01 tag for JSON reads
    close: (): void => undefined,
  };
}

function framesOf(target: SocketStub): string[] {
  return target.frames;
}

async function createSession(runtime: TerminalRuntime, over: Record<string, unknown> = {}): Promise<never | Awaited<ReturnType<TerminalRuntime['createSession']>>> {
  return await runtime.createSession({ ...BASE, ...over } as never);
}



const ESC = '\u001b';

function bufferFrame(frame: unknown): Buffer {
  return Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify(frame), 'utf8')]);
}

describe('create dedupe + cap (doc 07 section C.2)', () => {
  it('same id + same attrs returns the SAME session without a second PTY', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'tab-1' });
    const again = await runtime.createSession({ ...BASE, sessionId: 'tab-1' } as never);
    expect(again.sessionId).toBe('tab-1');
    expect(instances).toHaveLength(1);
  });

  it('same id with a different purpose or cwd is REJECTED', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    await createSession(runtime, { sessionId: 'tab-2' });
    await expect(runtime.createSession({ ...BASE, sessionId: 'tab-2', purpose: { type: 'project-action', actionId: 'x', executionId: 'e' } } as never))
      .rejects.toThrow('another purpose');
    await expect(createSession(runtime, { sessionId: 'tab-2', cwd: '/other' })).rejects.toThrow('another cwd');
    await expect(runtime.createSession({ ...BASE, sessionId: 'tab-2', mode: 'command', command: 'x' } as never)).rejects.toThrow('another command');
  });

  it('a running action peer for the same cwd+actionId is ADOPTED (no new PTY)', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    const created = await runtime.createSession({ ...BASE, sessionId: 'peer', purpose: { type: 'project-action', actionId: 'dev', executionId: 'exec-A' } } as never);
    const adopted = await runtime.createSession({ ...BASE, sessionId: 'peer-2', purpose: { type: 'project-action', actionId: 'dev', executionId: 'exec-B' } } as never);
    expect(adopted.sessionId).toBe(created.sessionId);
    expect(adopted.purpose).toEqual({ type: 'project-action', actionId: 'dev', executionId: 'exec-A' }); // execution identity travels in the response (section C.2 #3)
    expect(instances).toHaveLength(1);
  });

  it('pending single-flight: two rapid creates share one spawn', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    const purpose = { type: 'project-action' as const, actionId: 'dev', executionId: 'x' };
    const [a, b] = await Promise.all([
      runtime.createSession({ ...BASE, purpose } as never),
      runtime.createSession({ ...BASE, purpose } as never),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(instances).toHaveLength(1);
  });

  it('a delete racing an in-flight create tombstones the late PTY (section C.2 #7)', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    const flight = runtime.createSession({ ...BASE, sessionId: 'tab-9', cwd: RUNTIME_CWD } as never); // cwd stat pending
    runtime.close('tab-9');
    await expect(flight).rejects.toThrow('create cancelled before start');
    expect(instances[0]!.killed).toBe(true); // never registered
    expect(runtime.listSessions()).toHaveLength(0);
  });

  it('a tombstoned flight is not adoptable; a fresh same-id create starts its own flight', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    const poisoned = runtime.createSession({ ...BASE, sessionId: 'tomb', cwd: RUNTIME_CWD } as never);
    const defused = poisoned.catch(() => undefined); // no unhandled window while the later assertion awaits
    runtime.close('tomb'); // tombstones the in-flight create
    const survivor = await runtime.createSession({ ...BASE, sessionId: 'tomb', cwd: RUNTIME_CWD } as never);
    expect(survivor.sessionId).toBe('tomb');
    expect(survivor.status).toBe('running');
    await defused;
    await expect(poisoned).rejects.toThrow('create cancelled before start');
    expect(instances).toHaveLength(2);
    expect(instances.filter((instance) => instance.killed)).toHaveLength(1); // exactly the late victim died on arrival
    expect(instances.filter((instance) => !instance.killed)).toHaveLength(1); // the fresh flight lives
    expect(runtime.listSessions()).toHaveLength(1);
  });

  it('pending single-flight normalizes cwd spelling (backslash/slash/trailing slash)', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    const spelled = RUNTIME_CWD.replaceAll('\\', '/') + '/';
    const [a, b] = await Promise.all([
      runtime.createSession({ ...BASE, sessionId: 'norm-1', cwd: RUNTIME_CWD } as never),
      runtime.createSession({ ...BASE, sessionId: 'norm-1', cwd: spelled } as never),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(instances).toHaveLength(1); // a forward-slash respelling stays one flight
  });

  it('purpose ids are trimmed and capped at 128 (section 4.1)', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    const created = await runtime.createSession({
      ...BASE, sessionId: 'p-trim',
      purpose: { type: 'project-action', actionId: '  dev  ', executionId: 'exec 07 ' },
    } as never);
    expect(created.purpose).toEqual({ type: 'project-action', actionId: 'dev', executionId: 'exec 07' });
    await expect(runtime.createSession({
      ...BASE, sessionId: 'p-long', cwd: RUNTIME_CWD,
      purpose: { type: 'project-action', actionId: 'a', executionId: 'x'.repeat(130) },
    } as never)).rejects.toThrow('invalid project-action purpose');
  });

  it('the cap is 20 live records; invalid inputs are 400s', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    for (let index = 0; index < 20; index += 1) {
      await runtime.createSession({ ...BASE, sessionId: `cap-${index}` } as never);
    }
    await expect(createSession(runtime)).rejects.toThrow('cap');
    await expect(createSession(runtime, { sessionId: 'bad-dims', cols: 0 })).rejects.toThrow();
    await expect(createSession(runtime, { sessionId: 'bad-shell', shell: 'tcsh' as never })).rejects.toThrow();
    await expect(createSession(runtime, { sessionId: 'no-cmd', mode: 'command' } as never)).rejects.toThrow();
  });

  it('two concurrent creates near the cap cannot overshoot it', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    for (let index = 0; index < 19; index += 1) {
      await runtime.createSession({ ...BASE, sessionId: `cc-${index}` } as never);
    }
    const results = await Promise.allSettled([
      createSession(runtime, { sessionId: 'cc-a' }),
      createSession(runtime, { sessionId: 'cc-b' }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1); // registry is populated before the first await
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect(runtime.listSessions()).toHaveLength(20);
  });
});

describe('attach barrier + replay (sections 3.4-3.5)', () => {
  it('snapshot is ALWAYS the first event; late attach sees snapshot + nothing missed', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'tab-a' });
    const first = socket(1);
    const second = socket(2);
    runtime.handleSocketFrame(first, bufferFrame({ v: 3, t: 'attach', s: 'tab-a' }));
    instances[0]!.emit('hello '); // live
    instances[0]!.emit('world');
    runtime.handleSocketFrame(second, bufferFrame({ v: 3, t: 'attach', s: 'tab-a' }));
    const seen1 = framesOf(first);
    const seen2 = framesOf(second);
    expect(JSON.parse(seen1[0]!).t).toBe('snapshot'); // ALWAYS first
    expect(JSON.parse(seen1[1]!).q).toBe(1); // hello
    expect(JSON.parse(seen1[2]!).q).toBe(2); // world
    expect(JSON.parse(seen2[0]!)).toEqual(expect.objectContaining({ t: 'snapshot', q: 2, history: 'hello world' }));
    expect(seen2).toHaveLength(1); // barrier: everything up to q=2 rides the snapshot
  });

  it('replay text carries only sanitized bytes; `r` is present exactly when scrubbed', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'tab-r' });
    const watcher = socket(3);
    runtime.handleSocketFrame(watcher, bufferFrame({ v: 3, t: 'attach', s: 'tab-r' }));
    watcher.frames.length = 0;
    instances[0]!.emit('plain p');
    instances[0]!.emit(`q ${ESC}[5n ok`);
    const outputFrames = watcher.frames.map((row) => JSON.parse(row)).filter((frame) => frame.t === 'output');
    expect(outputFrames[0]).toEqual({ v: 3, t: 'output', s: 'tab-r', q: 1, d: 'plain p' });
    expect(outputFrames[1]!.d).toBe(`q ${ESC}[5n ok`); // live bytes stay byte-for-byte
    expect(outputFrames[1]!.r).toBe('q  ok'); // query exchange stripped from replay
    expect(instances[0]!.writes).toContain('[0n'); // DSR answered into the PTY, never published
  });
});

describe('write + exit + restart + close taxonomy (sections 3.3/4.7)', () => {
  it('write refreshes activity; NOT_RUNNING after exit; unknown session gets fatal SESSION_NOT_FOUND', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'tab-w' });
    runtime.handleSocketFrame(socket(1), bufferFrame({ v: 3, t: 'write', s: 'tab-w', d: 'ls\r' }));
    expect(instances[0]!.writes.at(-1)).toBe('ls\r');
    instances[0]!.exit(2);
    const stream = socket(2);
    runtime.handleSocketFrame(stream, bufferFrame({ v: 3, t: 'attach', s: 'tab-w' })); // exited sessions stay attachable
    const parsed = framesOf(stream).map((row) => JSON.parse(row));
    expect(parsed[0]!.status).toBe('exited');
    expect(parsed[0]!.exitCode).toBe(2);
    const unknown = socket(3);
    const result = runtime.handleSocketFrame(unknown, bufferFrame({ v: 3, t: 'write', s: 'ghost', d: 'x' }));
    expect(JSON.parse(result.unknownSessionError!.subarray(1).toString('utf8'))).toEqual({ v: 3, t: 'error', s: 'ghost', code: 'SESSION_NOT_FOUND', fatal: true });
    const notRunning = socket(4);
    runtime.handleSocketFrame(notRunning, bufferFrame({ v: 3, t: 'attach', s: 'tab-w' })); // recipient must be attached to see the error frame
    runtime.handleSocketFrame(notRunning, bufferFrame({ v: 3, t: 'write', s: 'tab-w', d: 'x' }));
    expect(JSON.parse(framesOf(notRunning).at(-1)!).code).toBe('NOT_RUNNING');
  });

  it('restart serializes, wires the replacement BEFORE killing the old, and publishes restarted with empty history', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'tab-x' });
    const viewer = socket(5);
    runtime.handleSocketFrame(viewer, bufferFrame({ v: 3, t: 'attach', s: 'tab-x' }));
    viewer.frames.length = 0;
    instances[0]!.emit('old content');

    await runtime.restart('tab-x', {});
    expect(instances).toHaveLength(2);
    expect(instances[0]!.killed).toBe(true); // old dies after the replacement is wired
    const parsed = framesOf(viewer).map((row) => JSON.parse(row));
    const restarted = parsed.find((frame) => frame.t === 'restarted');
    expect(restarted).toEqual({ v: 3, t: 'restarted', s: 'tab-x', q: 2, history: '' });
    const snapshot = parsed[0]!;
    expect(snapshot.q).toBe(1); // pre-restart state
    expect(() => runtime.restart('missing', {})).toThrow('not found'); // requireSession throws synchronously (same envelope)
  });

  it('command-mode restarts are refused (stale action metadata protection)', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    await runtime.createSession({ ...BASE, sessionId: 'cmd-1', mode: 'command', command: 'echo run' } as never);
    await expect(runtime.restart('cmd-1', {})).rejects.toThrow('command sessions cannot restart');
  });

  it('close broadcasts fatal CLOSED and terminates; force-kill by cwd kills the directory scope', async () => {
    const dirA = joinPath(RUNTIME_CWD, 'a');
    const dirB = joinPath(RUNTIME_CWD, 'b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await runtime.createSession({ ...BASE, sessionId: 'k-1', cwd: dirA });
    await runtime.createSession({ ...BASE, sessionId: 'k-2', cwd: dirB });
    const viewer = socket(6);
    runtime.handleSocketFrame(viewer, bufferFrame({ v: 3, t: 'attach', s: 'k-1' }));
    const killed = runtime.forceKill({ cwd: dirA });
    expect(killed).toEqual({ success: true, killedCount: 1, killedSessionIds: ['k-1'] });
    expect(instances[0]!.killed).toBe(true);
    expect(instances[1]!.killed).toBe(false);
    const closedFrame = JSON.parse(framesOf(viewer).at(-1)!);
    expect(closedFrame).toEqual({ v: 3, t: 'error', s: 'k-1', code: 'KILLED', fatal: true });
    runtime.close('k-2');
    expect(instances[1]!.killed).toBe(true);
    expect(runtime.listSessions()).toHaveLength(0);
  });

  it('idle reaper: unattached + old gets reaped; attached and touched survive', async () => {
    let clock = 0;
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances), () => clock);
    await createSession(runtime, { sessionId: 'idle-1' });
    const viewer = socket(7);
    runtime.handleSocketFrame(viewer, bufferFrame({ v: 3, t: 'attach', s: 'idle-1' }));
    clock = 40 * 60_000;
    (runtime as unknown as { sweepOnce(): void }).sweepOnce?.();
    expect(instances[0]!.killed).toBe(false); // attached -> NEVER idle
    const second: FakePty[] = [];
    const runtimeB = new TerminalRuntime(fakeFactory(second), () => clock);
    await runtimeB.createSession({ ...BASE, sessionId: 'idle-2' } as never);
    clock = 80 * 60_000; // 40 min past idle-2's lastActivity
    (runtimeB as unknown as { sweepOnce(): void }).sweepOnce?.();
    expect(second[0]!.killed).toBe(true); // unattached + beyond 30 min -> reaped
    expect(runtimeB.listSessions()).toHaveLength(0);
  });

  it('does not keep an exited record alive when a hidden project tab is stale', async () => {
    let clock = 0;
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances), () => clock);
    await createSession(runtime, { sessionId: 'hidden-exited' });
    await createSession(runtime, { sessionId: 'still-running' });
    clock = 60_000;
    instances[0]!.exit(0);
    clock = 20 * 60_000;
    expect(runtime.touch(['hidden-exited', 'still-running'])).toEqual({ touched: 1 });
    clock = 35 * 60_000;
    (runtime as unknown as { sweepOnce(): void }).sweepOnce();
    expect(runtime.listSessions().map((session) => session.sessionId)).toEqual(['still-running']);
    expect(instances[1]!.killed).toBe(false);
  });
});

describe('socket error taxonomy (section 3.3)', () => {
  it('BAD_FRAME is non-fatal; the socket stays open', () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    const bad = socket(8);
    runtime.handleSocketFrame(bad, Buffer.from('not binary'));
    runtime.handleSocketFrame(bad, 'also text');
    expect(bad.frames).toHaveLength(2);
    expect(JSON.parse(bad.frames[0]!.toString()).code).toBe('BAD_FRAME');
    expect(JSON.parse(bad.frames[0]!.toString()).code).toBe('BAD_FRAME');
  });
});

describe('exited id replacement + cap accounting (section C.2 #6, E-07-7/8)', () => {
  it('a create over an EXITED same-id record spawns a fresh PTY and SUPERSEDES the old viewers', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 're-1' });
    const viewer = socket(11);
    runtime.handleSocketFrame(viewer, bufferFrame({ v: 3, t: 'attach', s: 're-1' }));
    instances[0]!.emit('dead prompt');
    instances[0]!.exit(0);
    viewer.frames.length = 0;
    const recreated = await runtime.createSession({ ...BASE, sessionId: 're-1' } as never);
    expect(instances).toHaveLength(2); // a fresh PTY, not the adopted corpse
    expect(recreated.status).toBe('running');
    expect(JSON.parse(framesOf(viewer).at(-1)!)).toEqual({ v: 3, t: 'error', s: 're-1', code: 'SUPERSEDED', fatal: true });
    const fresh = socket(12);
    runtime.handleSocketFrame(fresh, bufferFrame({ v: 3, t: 'attach', s: 're-1' }));
    instances[1]!.emit('live');
    expect(JSON.parse(framesOf(fresh).at(-1)!).d).toBe('live'); // output flows from the replacement
  });

  it('an exited id still refuses a different cwd or purpose (section 4.1)', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    await createSession(runtime, { sessionId: 'gone-1' });
    await expect(createSession(runtime, { sessionId: 'gone-1', cwd: joinPath(RUNTIME_CWD, 'elsewhere') })).rejects.toThrow('another cwd');
    await expect(runtime.createSession({ ...BASE, sessionId: 'gone-1', purpose: { type: 'project-action', actionId: 'x', executionId: 'e' } } as never))
      .rejects.toThrow('another purpose');
  });

  it('exited PLAIN records count toward the cap; only replaceable action records do not', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    for (let index = 0; index < 18; index += 1) {
      await runtime.createSession({ ...BASE, sessionId: `ex-${index}` } as never);
    }
    await runtime.createSession({ ...BASE, sessionId: 'act-e', purpose: { type: 'project-action', actionId: 'dev', executionId: 'e1' } } as never);
    instances[18]!.exit(0); // exited run for the same action
    const redone = await runtime.createSession({ ...BASE, sessionId: 'act-new', purpose: { type: 'project-action', actionId: 'dev', executionId: 'e2' } } as never);
    expect(redone.sessionId).toBe('act-new'); // the exited action record was replaced, not counted
    expect(runtime.listSessions()).toHaveLength(18 + 1); // 18 plain + the new run (the old one retired)
    expect(instances[18]!.killed).toBe(false); // an already-exited run needs no kill
    await createSession(runtime, { sessionId: 'ex-18' } as never); // 20th live record
    await expect(createSession(runtime)).rejects.toThrow('cap'); // and this fresh create would be the 21st
  });

  it('a failed action create preserves the exited record it was going to replace (section C.2 #6)', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await runtime.createSession({ ...BASE, sessionId: 'act-keep', purpose: { type: 'project-action', actionId: 'dev', executionId: 'e1' } } as never);
    instances[0]!.exit(3);
    await expect(runtime.createSession({ ...BASE, sessionId: 'act-new2', cwd: joinPath(RUNTIME_CWD, 'missing-dir'), purpose: { type: 'project-action', actionId: 'dev', executionId: 'e2' } } as never))
      .rejects.toThrow('cwd does not exist');
    const listed = runtime.listSessions().find((session) => session.sessionId === 'act-keep');
    expect(listed).toBeDefined();
    expect(runtime.resize('act-keep', 100, 30)).toEqual({ success: true, cols: 100, rows: 30 }); // replayable record intact
  });
});

describe('restart chain keyed by id (section 4.7)', () => {
  it('a restart queued behind a COMPLETED restart re-targets the live session (no false 404)', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'r-que' });
    const first = runtime.restart('r-que', {});
    const second = runtime.restart('r-que', {});
    const [a, b] = await Promise.all([first, second]);
    expect(a.sessionId).toBe('r-que');
    expect(b.sessionId).toBe('r-que'); // the second ran against the CURRENT record, not the pre-restart one
    expect(instances).toHaveLength(3); // original + two replacements
    expect(runtime.listSessions()).toHaveLength(1);
  });

  it('restart options validation: non-boolean loginShell is a 400', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    await createSession(runtime, { sessionId: 'r-opt' });
    expect(() => runtime.restart('r-opt', { loginShell: 'yes' as never })).toThrow('invalid loginShell');
  });
});

describe('socket lifecycle + reaper interaction (E-07-12)', () => {
  it('detachSocket frees the record; the reaper can then reap it; late output is silent', async () => {
    let clock = 0;
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances), () => clock);
    await createSession(runtime, { sessionId: 'det-1' });
    const viewer = socket(13);
    runtime.handleSocketFrame(viewer, bufferFrame({ v: 3, t: 'attach', s: 'det-1' }));
    instances[0]!.emit('before');
    runtime.detachSocket(viewer);
    instances[0]!.emit('after');
    expect(framesOf(viewer).some((row) => row.includes('"after"'))).toBe(false); // dead socket hears nothing more
    clock = 40 * 60_000; // unattached now -> reapable
    (runtime as unknown as { sweepOnce(): void }).sweepOnce?.();
    expect(instances[0]!.killed).toBe(true);
    expect(runtime.listSessions()).toHaveLength(0);
  });

  it('force-kill requires a target (400 envelope) and tombstones matching in-flight creates', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    expect(() => runtime.forceKill({})).toThrow('requires sessionId or cwd');
    expect(() => runtime.forceKill({ sessionId: 5 as never })).toThrow();
    const flight = runtime.createSession({ ...BASE, sessionId: 'fk-1', cwd: RUNTIME_CWD } as never);
    const defused = flight.catch(() => undefined); // tombstoned flights reject; observe them deliberately
    runtime.forceKill({ cwd: RUNTIME_CWD });
    await defused;
    await expect(flight).rejects.toThrow('create cancelled before start'); // the late PTY can never register
    expect(runtime.listSessions()).toHaveLength(0);
  });
});

describe('appearance scalars (E-07-11)', () => {
  it('valid patch answers a Mode-2031 subscriber on change; strict scalars are 400s', async () => {
    const instances: FakePty[] = [];
    const runtime = new TerminalRuntime(fakeFactory(instances));
    await createSession(runtime, { sessionId: 'look-1' });
    instances[0]!.emit(`${ESC}[?2031h`); // program subscribes to theme notifications
    runtime.updateAppearance('look-1', { themeMode: 'light' });
    expect(instances[0]!.writes).toContain(`${ESC}[?997;2n`); // light = 2 (section 4.6)
    expect(() => runtime.updateAppearance('look-1', { themeMode: 'purple' as never })).toThrow('themeMode must be light or dark');
    expect(() => runtime.updateAppearance('look-1', { terminalBackground: 'x'.repeat(129) })).toThrow('too long');
    expect(() => runtime.updateAppearance('look-1', { terminalForeground: 7 as never })).toThrow('CSS color string');
    expect(() => runtime.updateAppearance('look-1', null as never)).toThrow('invalid appearance');
  });

  it('create validates the appearance the same way and requires a cwd', async () => {
    const runtime = new TerminalRuntime(fakeFactory([]));
    await expect(runtime.createSession({ ...BASE, sessionId: 'look-2', themeMode: 'purple' } as never)).rejects.toThrow('themeMode');
    await expect(runtime.createSession({ ...BASE, sessionId: 'look-3', terminalBackground: 'x'.repeat(129) } as never)).rejects.toThrow('too long');
    await expect(runtime.createSession({ cols: 80, rows: 24 } as never)).rejects.toThrow('cwd is required');
  });
});
