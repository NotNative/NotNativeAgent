// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal live gate (doc 07 checklist step 1/5): REAL node-pty ConPTY
 * spawn + WS transport + HTTP command plane, end to end: create a command
 * session, attach through /api/terminal/ws, snapshot-first ordering, live
 * output with the sanitized replay variant, exit frame with the process
 * code, then shells/sessions listings and clean shutdown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { WebSocket } from 'ws';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';
import { createTerminalRuntime } from '../terminal/bootstrap.ts';
import { attachTerminalWebsocket } from '../terminal/wire.ts';
import type { TerminalRuntime } from '../terminal/session-core.ts';

const isWindows = process.platform === 'win32'; // E-07-4: PTY parity suite targets Windows (ConPTY) only

let dataDir: string | null = null;
let repoDir: string | null = null;
let server: Server | null = null;
let runtime: TerminalRuntime | null = null;
let wsUrl = '';
let wiring: { dispose(): void } | null = null;

describe.skipIf(!isWindows)('terminal end to end (doc 07 sections 2.1/3/3.7)', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p71l-data-`);
    repoDir = mkdtempSync(`${tmpdir()}${sep}nnd-p71l-repo-`);
    process.env.NOTNATIVE_DATA_DIR = dataDir;
    runtime = createTerminalRuntime();
    registerHarnessAdapter(mockHarness);
    const app = createApp({ terminal: runtime });
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as unknown as Server;
    await new Promise<void>((resolvePromise) => server!.once('listening', resolvePromise));
    const address = server!.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    wsUrl = `ws://127.0.0.1:${port}/api/terminal/ws`;
    wiring = attachTerminalWebsocket(server as Server, runtime!);
  });

  afterAll(async () => {
    runtime?.dispose();
    wiring?.dispose();
    await new Promise<void>((resolvePromise) => server?.close(() => resolvePromise()));
    // ConPTY trees may release their handles a beat after close: bounded retry, never fatal
    for (const dir of [dataDir, repoDir]) {
      if (dir === null) continue;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try { rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((done) => setTimeout(done, 100)); }
      }
    }
  });

  it('create + attach + live output + exit over one socket, then the listings', async () => {
    execFileSync('cmd', ['/d', '/s', '/c', 'echo end-marker-once > marker.txt'], { cwd: repoDir! });
    const createInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: repoDir, mode: 'command', command: 'type marker.txt' }) };
    const createResponse = await fetch(`${httpBase()}/api/terminal/create`, createInit);
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as { sessionId: string; status: string; mode: string };
    expect(created.mode).toBe('command');
    expect(created.status).toBe('running');

    const listing = await (await fetch(`${httpBase()}/api/terminal/sessions?cwd=${encodeURIComponent(repoDir!)}`)).json() as { sessions: { sessionId: string; mode: string }[] };
    expect(listing.sessions.map((session) => session.sessionId)).toContain(created.sessionId);

    const socketFrames: unknown[] = [];
    const client = new WebSocket(wsUrl);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      client.once('open', () => resolvePromise());
      client.once('error', (error) => rejectPromise(error));
    });
    client.on('message', (data) => { socketFrames.push(JSON.parse(String(data).slice(1))); });
    client.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ v: 3, t: 'attach', s: created.sessionId }), 'utf8')])); // protocol v3: binary frames both ways

    let snapshotSeen = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (socketFrames.some((frame) => (frame as { t?: string }).t === 'exit')) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    for (const frame of socketFrames as { t: string; q?: number; history?: string; status?: string; d?: string; exitCode?: number }[]) {
      if (frame.t === 'snapshot') snapshotSeen = true;
      if (frame.t === 'exit') expect(frame.exitCode).toBe(0);
    }
    expect(snapshotSeen).toBe(true);
    const history = (socketFrames.find((frame) => (frame as { t?: string }).t === 'snapshot') as { history?: string } | undefined)?.history ?? '';
    const live = socketFrames.filter((frame) => (frame as { t?: string }).t === 'output')
      .map((frame) => (frame as { d?: string }).d ?? '').join('');
    expect(history + live).toContain('end-marker-once');
    client.close();
    await expectDetached(runtime!, created.sessionId); // E-07-12: close drops every attachment
  });

  it('shells and sessions command-plane shapes (no command text ever)', async () => {
    const shells = await (await fetch(`${httpBase()}/api/terminal/shells`)).json() as { id: string; name: string; supportsLogin: boolean }[];
    expect(Array.isArray(shells)).toBe(true);
    expect(shells.length).toBeGreaterThan(0);
    expect(['cmd', 'powershell', 'pwsh'].some((id) => shells.some((shell) => shell.id === id))).toBe(true);
    const sessionsBody = await (await fetch(`${httpBase()}/api/terminal/sessions`)).json() as { sessions: { sessionId: string }[] };
    expect(Array.isArray(sessionsBody.sessions)).toBe(true);
  });

  it('envelope edge cases: force-kill needs a target, missing cwd is a plain 400, touch ignores junk', async () => {
    const emptyKill = await fetch(`${httpBase()}/api/terminal/force-kill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(emptyKill.status).toBe(400);
    expect(((await emptyKill.json()) as { error?: string }).error).toContain('requires sessionId or cwd');
    const noCwd = await fetch(`${httpBase()}/api/terminal/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'command', command: 'x' }) });
    expect(noCwd.status).toBe(400);
    expect(((await noCwd.json()) as { code?: string }).code).toBeUndefined(); // only the recoverable cwd case carries a code
    const missingCwd = await fetch(`${httpBase()}/api/terminal/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: joinPath(repoDir!, 'definitely-not-here'), mode: 'command', command: 'x' }) });
    expect(missingCwd.status).toBe(400);
    expect(((await missingCwd.json()) as { code?: string }).code).toBe('TERMINAL_CWD_MISSING');

    const runner = await (await fetch(`${httpBase()}/api/terminal/create`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: repoDir, mode: 'command', command: 'ping -n 30 127.0.0.1' }),
    })).json() as { sessionId: string };
    const touched = await (await fetch(`${httpBase()}/api/terminal/touch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionIds: [runner.sessionId, 42, null] }) })).json() as { touched: number };
    expect(touched.touched).toBe(1); // strings only; junk sessionIds never crash the loop
    const killed = await (await fetch(`${httpBase()}/api/terminal/force-kill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: runner.sessionId }) })).json() as { killedCount: number; killedSessionIds: string[] };
    expect(killed).toEqual({ success: true, killedCount: 1, killedSessionIds: [runner.sessionId] });
    const after = await (await fetch(`${httpBase()}/api/terminal/sessions`)).json() as { sessions: { sessionId: string }[] };
    expect(after.sessions.some((session) => session.sessionId === runner.sessionId)).toBe(false);
  });
});

function httpBase(): string {
  if (server === null) throw new Error('server missing');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** The WS close handler must drop the attachment from EVERY session
 * (E-07-12): a held dead attachment would block the idle reaper. */
async function expectDetached(target: TerminalRuntime, sessionId: string): Promise<void> {
  const registry = (target as unknown as { sessions: Map<string, { attached: Set<unknown> }> }).sessions;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const record = registry.get(sessionId);
    if (record?.attached.size === 0) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`socket close did not release attachments (session ${sessionId})`);
}
