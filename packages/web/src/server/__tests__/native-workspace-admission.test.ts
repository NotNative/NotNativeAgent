// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { admitNativeWorkspace, handleNativeSessionCreation, registerNativeWorkspaceAdmissionRoute } from '../routes/native-workspace-admission.ts';
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
