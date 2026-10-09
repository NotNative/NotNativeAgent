// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { nativeAlphaMutationUnavailable } from '../routes/native-alpha-surface.ts';

afterEach(() => vi.unstubAllEnvs());

it('closes NND-owned mutations but leaves native chat, setup, review, and reads available', () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  for (const path of ['/api/fs/write', '/api/git/commit', '/api/git/worktrees',
    '/api/message-queue/sessions/s1/items', '/api/projects/p1/scheduled-tasks/task/run',
    '/api/project-context/p1/notes', '/api/config/skills/install', '/api/openchamber/tunnel/start']) {
    expect(nativeAlphaMutationUnavailable('POST', path), path).toBe(true);
  }
  for (const path of ['/api/session', '/api/session/s1/prompt_async', '/api/file',
    '/api/permission/p1/reply', '/api/v1/nnd/setup/activate', '/api/v1/nnd/configuration']) {
    expect(nativeAlphaMutationUnavailable('POST', path), path).toBe(false);
  }
  expect(nativeAlphaMutationUnavailable('GET', '/api/git/status')).toBe(false);
  expect(nativeAlphaMutationUnavailable('POST', '/api/github')).toBe(false);
});

it('refuses installed Git, file, and queue mutations before their handlers run', async () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  const app = createApp();
  for (const path of ['/api/fs/write', '/api/git/commit', '/api/message-queue/sessions/s1/items']) {
    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status, path).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'native_alpha_surface_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

it('retains development and mock mutations', () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'web');
  vi.stubEnv('NOTNATIVE_HARNESS', 'mock');
  expect(nativeAlphaMutationUnavailable('POST', '/api/fs/write')).toBe(false);
});
