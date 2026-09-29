// SPDX-License-Identifier: Apache-2.0
/** P10-45 mock harness MCP runtime (doc 02 P-14 / §6.9; doc 15 F.3): live
 * status derived from the config layers, connect/disconnect traces, the OAuth
 * faces, and mcp.tools.changed emission. Config writes ride the SAME lib the
 * /api/config/mcp routes use, so layer provenance is the production one. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const ORIGIN = 'http://mock-mcp.test';

let mockHarness: { handle(request: Request): Promise<Response> };
let createMcpConfig: (name: string, raw: unknown) => Promise<unknown>;

async function call(path: string, init?: RequestInit): Promise<Response> {
  return mockHarness.handle(new Request(ORIGIN + path, init));
}

const jsonCall = (path: string, method: string, body: unknown): Promise<Response> =>
  call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

type StatusMap = Record<string, { status: string; error?: string }>;

async function statusMap(): Promise<StatusMap> {
  const response = await call('/api/mcp');
  expect(response.status).toBe(200);
  return await response.json() as StatusMap;
}

let root = '';
let caseIndex = 0;
let projectDir = '';
let previousConfigDir: string | undefined;

beforeAll(async () => {
  root = mkdtempSync(tmpdir() + '/nnd-p1045-mcp-');
  projectDir = joinPath(root, 'project');
  mkdirSync(joinPath(projectDir, '.opencode'), { recursive: true });
  previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
  mockHarness = (await import('../harness/mock/index.ts')).mockHarness;
  createMcpConfig = (await import('../lib/mcp/mcp-config.ts')).createMcpConfig;
});

beforeEach(async () => {
  caseIndex += 1;
  const userDir = joinPath(root, 'user-' + caseIndex);
  mkdirSync(userDir, { recursive: true });
  process.env.OPENCODE_CONFIG_DIR = userDir;
  (await import('../harness/mock/mcp.ts')).resetMockMcp();
});

afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  const { rmSync } = await import('node:fs');
  rmSync(root, { recursive: true, force: true });
});

const addLocal = (name: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
  createMcpConfig(name, { type: 'local', command: ['npx', '-y', 'demo-server'], ...extra });

describe('mock harness MCP runtime (P10-45)', () => {
  it('reports an empty status map when nothing is configured', async () => {
    expect(await statusMap()).toEqual({});
  });

  it('derives connected/disabled from the user layer', async () => {
    await addLocal('alpha');
    await addLocal('beta', { enabled: false });
    expect(await statusMap()).toEqual({
      alpha: { status: 'connected' },
      beta: { status: 'disabled' },
    });
  });

  it('lists project-layer entries for a scoped directory query', async () => {
    await createMcpConfig('proj-serve', {
      type: 'remote', url: 'https://mcp.test/mcp',
      scope: 'project', directory: projectDir,
    });
    const scoped = await call('/api/mcp?directory=' + encodeURIComponent(projectDir));
    expect(Object.keys(await scoped.json() as StatusMap)).toContain('proj-serve');
    expect(Object.keys(await statusMap())).not.toContain('proj-serve');
  });

  it('requires auth for oauth-configured remote servers', async () => {
    await createMcpConfig('oauthy', {
      type: 'remote', url: 'https://mcp.test/oauth', oauth: { clientId: 'cid' },
    });
    expect(await statusMap()).toEqual({ oauthy: { status: 'needs_auth' } });
    const refused = await call('/api/mcp/oauthy/connect', { method: 'POST' });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('requires authentication');
  });

  it('runs the OAuth start/callback/remove faces', async () => {
    await createMcpConfig('oauthy', {
      type: 'remote', url: 'https://mcp.test/oauth', oauth: { clientId: 'cid' },
    });
    const start = await call('/api/mcp/oauthy/auth', { method: 'POST' });
    expect(start.status).toBe(200);
    const startBody = await start.json() as { authorizationUrl?: string };
    expect(startBody.authorizationUrl).toContain('state=nndmock');
    const missing = await jsonCall('/api/mcp/oauthy/auth/callback', 'POST', {});
    expect(missing.status).toBe(400);
    const done = await jsonCall('/api/mcp/oauthy/auth/callback', 'POST', { code: 'abc' });
    expect(await done.json()).toEqual({ oauthy: { status: 'connected' } });
    const removed = await call('/api/mcp/oauthy/auth', { method: 'DELETE' });
    expect(await removed.json()).toEqual({ success: true });
    expect(await statusMap()).toEqual({ oauthy: { status: 'needs_auth' } });
    const unknown = await call('/api/mcp/ghost/auth', { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('completes the native authenticate flow instantly', async () => {
    await createMcpConfig('oauthy', {
      type: 'remote', url: 'https://mcp.test/oauth', oauth: {},
    });
    await addLocal('plain-local');
    await createMcpConfig('plain-remote', { type: 'remote', url: 'https://mcp.test/plain' });
    expect((await call('/api/mcp/oauthy/auth/authenticate', { method: 'POST' })).status).toBe(200);
    const map = await statusMap();
    expect(map.oauthy).toEqual({ status: 'connected' });
    expect(map['plain-remote']).toEqual({ status: 'connected' });
    const localAuth = await call('/api/mcp/plain-local/auth/authenticate', { method: 'POST' });
    expect(localAuth.status).toBe(400);
    expect(await localAuth.text()).toContain('remote');
  });

  it('traces disconnect until the next connect', async () => {
    await addLocal('alpha');
    const off = await call('/api/mcp/alpha/disconnect', { method: 'POST' });
    expect(await off.json()).toEqual({ alpha: { status: 'disabled' } });
    expect(await statusMap()).toEqual({ alpha: { status: 'disabled' } });
    const on = await call('/api/mcp/alpha/connect', { method: 'POST' });
    expect(await on.json()).toEqual({ alpha: { status: 'connected' } });
  });

  it('reports failed for servers configured with the fail token', async () => {
    await addLocal('boom', { environment: { DEMO: 'nnd-mock-fail' } });
    const failed = { boom: { status: 'failed', error: 'mock connection failed for "boom"' } };
    expect(await statusMap()).toEqual(failed);
    const attempt = await call('/api/mcp/boom/connect', { method: 'POST' });
    expect(attempt.status).toBe(200);
    expect(await attempt.json()).toEqual(failed);
  });

  it('creates through POST /mcp and rejects invalid shapes', async () => {
    const created = await jsonCall('/api/mcp', 'POST', {
      name: 'added-one', config: { type: 'local', command: ['demo'] },
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ 'added-one': { status: 'connected' } });
    const again = await jsonCall('/api/mcp', 'POST', {
      name: 'added-one', config: { type: 'local', command: ['demo'] },
    });
    expect(again.status).toBe(500);
    const badName = await jsonCall('/api/mcp', 'POST', {
      name: 'Bad Name!', config: { type: 'local', command: ['demo'] },
    });
    expect(badName.status).toBe(400);
    const badBody = await jsonCall('/api/mcp', 'POST', { name: 'missing-command', config: { type: 'local' } });
    expect(badBody.status).toBe(400);
    const invalidName = await call('/api/mcp/Bad%20Name/connect', { method: 'POST' });
    expect(invalidName.status).toBe(400);
    const unknown = await call('/api/mcp/ghost/connect', { method: 'POST' });
    expect(unknown.status).toBe(404);
    await addLocal('off-one', { enabled: false });
    const connectDisabled = await call('/api/mcp/off-one/connect', { method: 'POST' });
    const failed = { boom: { status: 'failed', error: 'mock connection failed for "boom"' } };
    expect(await connectDisabled.text()).toContain('disabled');
    const off = await call('/api/mcp/off-one/disconnect', { method: 'POST' });
    expect(off.status).toBe(200);
    const ghost = await call('/api/mcp/ghost/disconnect', { method: 'POST' });
    expect(ghost.status).toBe(404);
  });

  it('emits mcp.tools.changed on the scoped event stream', async () => {
    await addLocal('alpha');
    const controller = new AbortController();
    const response = await call('/api/event', { signal: controller.signal });
    const reader = response.body!.getReader();
    const collect = (async (): Promise<string[]> => {
      const decoder = new TextDecoder();
      const seen: string[] = [];
      for (; ;) {
        const read = await reader.read();
        if (read.done) break;
        const text = decoder.decode(read.value, { stream: true });
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const frame = JSON.parse(line.slice(6)) as { payload?: { type?: string } };
            if (frame.payload?.type) seen.push(frame.payload.type);
          } catch { /* partial frame */ }
        }
        if (seen.includes('mcp.tools.changed')) break;
      }
      return seen;
    })();
    await call('/api/mcp/alpha/disconnect', { method: 'POST' });
    await call('/api/mcp/alpha/connect', { method: 'POST' });
    const types = await Promise.race([
      collect,
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 4000)),
    ]);
    controller.abort();
    expect(types).toContain('mcp.tools.changed');
  });
});
