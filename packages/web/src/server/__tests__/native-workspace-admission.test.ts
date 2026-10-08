// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { admitCreatedNativeWorkspace, admitNativeWorkspace, assertNativeWorkspaceRoot, assertNoNativeWorkspaceSessions, handleNativeSessionCreation, registerNativeWorkspaceAdmissionRoute, revokeNativeWorkspaceForRemoval } from '../routes/native-workspace-admission.ts';
import { callHarness } from '../queue/queue-adapter-calls.ts';

let scratch = '', rootA = '', rootB = '', alias = '';
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nnd-workspace-admission-'));
  rootA = join(scratch, 'A').replaceAll('\\', '/');
  rootB = join(scratch, 'B').replaceAll('\\', '/');
  alias = join(scratch, 'alias').replaceAll('\\', '/');
  await mkdir(rootA); await mkdir(rootB);
  await symlink(rootA, alias, process.platform === 'win32' ? 'junction' : 'dir');
});
afterAll(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

it('admits only the native attached repository through the HTTP route', async () => {
  registerHarnessAdapter({ handle: async request => {
    expect(new URL(request.url).pathname).toBe('/api/path');
    return Response.json({ directory: rootA, worktree: rootA, home: '', state: '', config: '' });
  } });
  const app = new Hono(); registerNativeWorkspaceAdmissionRoute(app);
  const approved = await app.request(`/api/native-workspace/admission?directory=${encodeURIComponent(rootA)}`);
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ directory: rootA });
  const other = await app.request(`/api/native-workspace/admission?directory=${encodeURIComponent(rootB)}`);
  expect(other.status).toBe(409);
  expect(await other.text()).toContain('Select that workspace');
});

it('fails closed on a junction and conflicting native evidence', async () => {
  await expect(admitNativeWorkspace(alias, async () => ({ directory: alias, worktree: alias })))
    .rejects.toThrow('filesystem identity is unavailable');
  await expect(admitNativeWorkspace(rootA, async () => ({ directory: rootA, worktree: rootB })))
    .rejects.toThrow('workspace identity is unavailable');
  await expect(admitNativeWorkspace(`${scratch}/A/../A`, async () => ({ directory: rootA, worktree: rootA })))
    .rejects.toThrow('workspace identity is unavailable');
});

it('guards direct and internal session creation before forwarding, including forks', async () => {
  const seen: string[] = [];
  registerHarnessAdapter({ handle: async request => {
    const path = new URL(request.url).pathname;
    seen.push(path);
    return path === '/api/path' ? Response.json({ directory: rootA, worktree: rootA })
      : Response.json({ id: 'ses_1', directory: rootA });
  } });
  const create = (path: string, directory: string) => callHarness(new Request(`http://local${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nnd-directory': directory },
    body: JSON.stringify({ directory }),
  }));
  expect((await create('/api/session', rootB)).status).toBe(409);
  expect(seen).toEqual(['/api/path']);
  expect((await create('/api/session/ses_1/fork', rootB)).status).toBe(409);
  expect(seen).toEqual(['/api/path', '/api/path']);
  expect((await create('/api/session', rootA)).status).toBe(200);
  expect(seen.at(-1)).toBe('/api/session');
  const encoded = await callHarness(new Request('http://local/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nnd-directory': encodeURIComponent(rootA),
      'x-nnd-directory-encoding': 'uri' }, body: JSON.stringify({ directory: rootA }),
  }));
  expect(encoded.status).toBe(200);
});

it('preserves race-created sessions but refuses their changed directory', async () => {
  registerHarnessAdapter({ handle: async request => new URL(request.url).pathname === '/api/path'
    ? Response.json({ directory: rootA, worktree: rootA })
    : Response.json({ id: 'ses_race', directory: rootB }) });
  const response = await callHarness(new Request('http://local/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nnd-directory': rootA },
    body: JSON.stringify({ directory: rootA }),
  }));
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('ses_race');
});

it('accepts equivalent native slash spelling without admitting a different root', async () => {
  const nativeSpelling = rootA.replaceAll('/', '\\');
  const forward = async () => Response.json({ id: 'ses_native', directory: nativeSpelling });
  const create = (directory: string) => handleNativeSessionCreation(new Request('http://local/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nnd-directory': directory },
    body: JSON.stringify({ directory }),
  }), forward, async () => ({ directory: nativeSpelling, worktree: nativeSpelling }));
  expect((await create(nativeSpelling)).status).toBe(200);
  expect((await create(rootB)).status).toBe(409);
});

it.skipIf(process.platform !== 'win32')('accepts Windows case aliases in requests and native create responses', async () => {
  const alternateCase = rootA.replace(/A$/u, 'a');
  expect(alternateCase).not.toBe(rootA);
  const forward = async () => Response.json({ id: 'ses_case', directory: alternateCase });
  const create = (directory: string) => handleNativeSessionCreation(new Request('http://local/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nnd-directory': directory },
    body: JSON.stringify({ directory }),
  }), forward, async () => ({ directory: rootA, worktree: alternateCase }));
  expect((await create(alternateCase)).status).toBe(200);
  expect((await create(rootB)).status).toBe(409);
});

it('uses the native admitted ID for a second root and checks the created session', async () => {
  const selectedId = `ws_${'a'.repeat(24)}`;
  const seen: { directory?: string; workspace_id?: string }[] = [];
  registerHarnessAdapter({ handle: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api/path') return Response.json({ directory: rootA, worktree: rootA });
    if (path === '/api/v1/nnd/workspaces/admissions') return Response.json({ selection_enabled: true,
      attached: { root: rootA }, admitted: [{ root: rootB, id: selectedId }] });
    if (path === '/api/session') {
      seen.push(await request.json() as { directory?: string; workspace_id?: string });
      return Response.json({ id: 'ses_selected', directory: rootB, projectID: selectedId });
    }
    return new Response(null, { status: 404 });
  } });
  const app = new Hono(); registerNativeWorkspaceAdmissionRoute(app);
  const admitted = await app.request(`/api/native-workspace/admission?directory=${encodeURIComponent(rootB)}`);
  expect(admitted.status).toBe(200);
  expect(await admitted.json()).toEqual({ directory: rootB, workspace_id: selectedId });
  const created = await callHarness(new Request('http://local/api/session', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nnd-directory': rootB },
    body: JSON.stringify({ directory: rootB, workspace_id: selectedId }),
  }));
  expect(created.status).toBe(200);
  expect(seen).toEqual([{ directory: rootB, workspace_id: selectedId }]);
  const wrongId = await callHarness(new Request('http://local/api/session', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nnd-directory': rootB },
    body: JSON.stringify({ directory: rootB, workspace_id: `ws_${'b'.repeat(24)}` }),
  }));
  expect(wrongId.status).toBe(409);
  expect(seen).toHaveLength(1);
});

it('admits a created worktree with native readback and resolves a lost acknowledgment', async () => {
  const selectedId = `ws_${'c'.repeat(24)}`;
  let admitted = false;
  let postCount = 0;
  const operations: string[] = [];
  registerHarnessAdapter({ handle: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api/path') return Response.json({ directory: rootA, worktree: rootA });
    if (path === '/api/v1/nnd/workspaces/admissions' && request.method === 'GET') {
      return Response.json({ installation_id: 'installation_test', data_id: 'data_test',
        revision: admitted ? 'a'.repeat(64) : 'absent', selection_enabled: true,
        attached: { root: rootA }, admitted: admitted ? [{ root: rootB, id: selectedId, operation_id: operations[0] }] : [] });
    }
    if (path === '/api/v1/nnd/workspaces/admissions' && request.method === 'POST') {
      const body = await request.json() as { expected_revision: string; operation_id: string; root: string };
      expect(body.expected_revision).toBe('absent');
      expect(body.root).toBe(rootB);
      operations.push(body.operation_id);
      postCount += 1;
      admitted = true;
      throw new Error('acknowledgment lost');
    }
    if (path === `/api/v1/nnd/workspaces/admissions/operations/${operations[0]}`) return new Response(null, { status: 404 });
    return new Response(null, { status: 404 });
  } });
  await expect(assertNativeWorkspaceRoot(rootB)).rejects.toThrow('not admitted');
  expect(await admitCreatedNativeWorkspace(rootB)).toBe(selectedId);
  expect(postCount).toBe(1);
  await expect(assertNativeWorkspaceRoot(rootB)).resolves.toBeUndefined();
});

it('refuses removal with an archived session and revokes an unused removed root', async () => {
  let bound = true;
  let admitted = true;
  let revokeCount = 0;
  registerHarnessAdapter({ handle: async request => {
    const path = new URL(request.url).pathname;
    if (path === '/api/session') return Response.json(bound ? [{ id: 'session_old', directory: rootB }] : []);
    if (path === '/api/v1/nnd/workspaces/admissions' && request.method === 'GET') {
      return Response.json({ installation_id: 'installation_test', data_id: 'data_test',
        revision: admitted ? 'a'.repeat(64) : 'b'.repeat(64), selection_enabled: true,
        attached: { root: rootA }, admitted: [],
        unavailable: admitted ? [{ root: rootB, id: `ws_${'c'.repeat(24)}`, reason: 'identity_mismatch' }] : [] });
    }
    if (path === '/api/v1/nnd/workspaces/admissions/revoke') {
      const body = await request.json() as { root: string; expected_revision: string; operation_id: string };
      expect(body.root).toBe(rootB);
      expect(body.expected_revision).toBe('a'.repeat(64));
      revokeCount += 1;
      admitted = false;
      return Response.json({ persistence: 'saved', operation_id: body.operation_id });
    }
    return new Response(null, { status: 404 });
  } });
  await expect(assertNoNativeWorkspaceSessions(rootB)).rejects.toThrow('still has NNA sessions');
  bound = false;
  await expect(assertNoNativeWorkspaceSessions(rootB)).resolves.toBeUndefined();
  await revokeNativeWorkspaceForRemoval(rootB);
  expect(revokeCount).toBe(1);
});
