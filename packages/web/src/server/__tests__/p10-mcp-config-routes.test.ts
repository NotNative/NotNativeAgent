// SPDX-License-Identifier: Apache-2.0
/** P10-44 MCP config-layer routes (doc 15 F.1/F.2): bounded records,
 * layer provenance, persistence, and deferred-restart payloads. */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { Hono } from 'hono';

const ROOT = mkdtempSync(`${tmpdir()}${sep}nnd-p1044-mcp-`);
const USER_CONFIG = joinPath(ROOT, 'user');
const PROJECT = joinPath(ROOT, 'project');
const USER_FILE = joinPath(USER_CONFIG, 'opencode.json');
const PROJECT_FILE = joinPath(PROJECT, '.opencode', 'opencode.json');

const { registerMcpConfigRoutes } = await import('../routes/mcp-config.ts');
const { listMcpConfig } = await import('../lib/mcp/mcp-config.ts');

const app = new Hono();
registerMcpConfigRoutes(app);

const call = (path: string, init?: RequestInit): Promise<Response> =>
  app.fetch(new Request(`http://t.test${path}`, {
    headers: { 'content-type': 'application/json' }, ...init,
  })) as Promise<Response>;

const send = (path: string, method: string, body: unknown): Promise<Response> =>
  call(path, { method, body: JSON.stringify(body) });

beforeAll(() => {
  process.env.OPENCODE_CONFIG_DIR = USER_CONFIG;
  mkdirSync(PROJECT, { recursive: true });
});

afterAll(() => {
  delete process.env.OPENCODE_CONFIG_DIR;
  rmSync(ROOT, { recursive: true, force: true });
});

const readUser = (): Record<string, unknown> =>
  JSON.parse(readFileSync(USER_FILE, 'utf8')) as Record<string, unknown>;

const readProject = (): Record<string, unknown> =>
  JSON.parse(readFileSync(PROJECT_FILE, 'utf8')) as Record<string, unknown>;

describe('MCP config-layer routes (P10-44)', () => {
  it('creates layered entries and overlays project over user', async () => {
    const local = await send('/api/config/mcp/shared-name', 'POST', {
      scope: 'user', type: 'local', command: ['npx', '-y', '@scope/server'],
      environment: { TOKEN: 'user-value' }, name: 'stripped',
    });
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({
      requiresReload: false, requiresRestart: true, restartDeferred: true,
      message: 'MCP server "shared-name" created. Restart OpenCode to apply.',
    });
    expect(readUser().mcp).toEqual({
      'shared-name': { type: 'local', command: ['npx', '-y', '@scope/server'],
        environment: { TOKEN: 'user-value' }, enabled: true },
    });

    const remote = await send('/api/config/mcp/shared-name', 'POST', {
      scope: 'project', directory: PROJECT, type: 'remote',
      url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer project' },
      environment: { TOKEN: 'project-value' },
      oauth: { clientId: 'id ', clientSecret: 'secret', scope: 'mcp',
        redirectUri: 'https://ui.example/callback' },
      timeout: 30_000, enabled: false,
    });
    expect(remote.status).toBe(200);
    expect(readProject().mcp).toEqual({
      'shared-name': { type: 'remote', url: 'https://mcp.example/sse',
        headers: { Authorization: 'Bearer project' },
        environment: { TOKEN: 'project-value' },
        oauth: { clientId: 'id', clientSecret: 'secret', scope: 'mcp',
          redirectUri: 'https://ui.example/callback' },
        timeout: 30_000, enabled: false },
    });
    const list = await listMcpConfig(PROJECT);
    expect(list).toEqual({
      'shared-name': { name: 'shared-name', scope: 'project', type: 'remote',
        url: 'https://mcp.example/sse', headers: { Authorization: 'Bearer project' },
        environment: { TOKEN: 'project-value' },
        oauth: { clientId: 'id', clientSecret: 'secret', scope: 'mcp',
          redirectUri: 'https://ui.example/callback' },
        timeout: 30_000, enabled: false },
    });
  });

  it('reads by name and preserves unknown config hashes', async () => {
    const record = await (await call('/api/config/mcp/shared-name?directory=' +
      encodeURIComponent(PROJECT))).json();
    expect(record).toMatchObject({ scope: 'project', type: 'remote', enabled: false });
  });

  it('patches the source layer and cleans blank map rows', async () => {
    const patched = await send('/api/config/mcp/shared-name?directory=' +
      encodeURIComponent(PROJECT), 'PATCH', {
      environment: {}, enabled: true, timeout: null,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({
      requiresReload: false, requiresRestart: true, restartDeferred: true,
      message: 'MCP server "shared-name" updated. Restart OpenCode to apply.',
    });
    const projectRecord = readProject().mcp as Record<string, Record<string, unknown>>;
    const projectShared = projectRecord['shared-name']!;
    expect(projectShared.environment).toEqual({});
    expect(projectShared).not.toHaveProperty('timeout');
    const userRecord = (readUser().mcp as Record<string, Record<string, unknown>>)['shared-name']!;
    expect(userRecord.environment).toEqual({ TOKEN: 'user-value' });
  });

  it('rejects invalid records and duplicate keys before disk mutation', async () => {
    const hash = JSON.stringify(readUser());
    const nullScope = await send('/api/config/mcp/null-scope', 'POST', {
      scope: null, type: 'local', command: ['x'],
    });
    expect(nullScope.status).toBe(400);

    const invalidName = await send('/api/config/mcp/BadName', 'POST', {
      type: 'local', command: ['x'],
    });
    expect(invalidName.status).toBe(400);
    const invalidLocal = await send('/api/config/mcp/invalid-local', 'POST', {
      type: 'local', command: [],
    });
    expect(invalidLocal.status).toBe(400);
    const invalidRemote = await send('/api/config/mcp/invalid-remote', 'POST', {
      type: 'remote', url: 'file:///unsafe',
    });
    expect(invalidRemote.status).toBe(400);
    const missingDirectory = await send('/api/config/mcp/no-project', 'POST', {
      scope: 'project', type: 'local', command: ['x'],
    });
    expect(missingDirectory.status).toBe(400);
    const duplicate = await send('/api/config/mcp/shared-name', 'POST', {
      type: 'local', command: ['x'],
    });
    expect(duplicate.status).toBe(500);
    expect(await duplicate.json()).toEqual({ error: 'MCP server "shared-name" already exists' });
    expect(JSON.stringify(readUser())).toBe(hash);
  });

  it('normalizes OAuth discovery and explicit disable', async () => {
    const whitespaceOauth = await send('/api/config/mcp/whitespace-oauth', 'POST', {
      type: 'remote', url: 'https://whitespace.example/mcp', oauth: { clientId: '   ' },
    });
    expect(whitespaceOauth.status).toBe(200);
    const whitespaceRecord = (readUser().mcp as Record<string, Record<string, unknown>>)['whitespace-oauth']!;
    expect(whitespaceRecord).not.toHaveProperty('oauth');

    const discovery = await send('/api/config/mcp/oauth-dev', 'POST', {
      type: 'remote', url: 'https://oauth.example/mcp', oauthEnabled: true,
    });
    expect(discovery.status).toBe(200);
    const disabled = await send('/api/config/mcp/oauth-dev', 'PATCH', { oauth: false });
    expect(disabled.status).toBe(200);
    const userRecord = readUser().mcp as Record<string, Record<string, unknown>>;
    expect(userRecord['oauth-dev']!.oauth).toBe(false);
  });

  it('unknown routes answer 404 with the registered message', async () => {
    const missingGet = await call('/api/config/mcp/missing-server');
    expect(missingGet.status).toBe(404);
    expect(await missingGet.json()).toEqual({ error: 'MCP server "missing-server" not found' });
    const missingPatch = await send('/api/config/mcp/missing-server', 'PATCH', { enabled: false });
    expect(missingPatch.status).toBe(404);
  });

  it('deletes from the layer that supplied the entry', async () => {
    const removed = await send('/api/config/mcp/shared-name?directory=' +
      encodeURIComponent(PROJECT), 'DELETE', undefined);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      requiresReload: false, requiresRestart: true, restartDeferred: true,
      message: 'MCP server "shared-name" deleted. Restart OpenCode to apply.',
    });
    expect((readProject() as Record<string, unknown>).mcp).toBeUndefined();
    const fallback = await (await call('/api/config/mcp/shared-name')).json() as { scope: string };
    expect(fallback.scope).toBe('user');
    const userRecord = (readUser().mcp as Record<string, Record<string, unknown>>)['shared-name']!;
    expect(userRecord.environment).toEqual({ TOKEN: 'user-value' });
    await send('/api/config/mcp/shared-name', 'DELETE', undefined);
    await send('/api/config/mcp/oauth-dev', 'DELETE', undefined);
    await send('/api/config/mcp/whitespace-oauth', 'DELETE', undefined);
    expect((readUser() as Record<string, unknown>).mcp).toBeUndefined();
  });
});
