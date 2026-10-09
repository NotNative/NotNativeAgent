// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { nativeAlphaMutationUnavailable } from '../routes/native-alpha-surface.ts';

afterEach(() => vi.unstubAllEnvs());

it('closes NND-owned mutations but leaves native chat, setup, review, and reads available', () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  for (const path of ['/api/fs/write', '/api/git/commit', '/api/git/worktrees',
    '/api/message-queue/sessions/s1/items', '/api/projects/p1/scheduled-tasks/task/run',
    '/api/project-context/p1/notes', '/api/config/skills/install', '/api/openchamber/tunnel/start',
    '/api/notnative/update-install']) {
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

it('accounts for every literal NND-owned mutating route in the installed alpha', () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const exceptions = new Set([
    '/api/auth/reset', // Auth route is registered before the API alpha gate.
    '/api/passkeys/:id', // Auth route is registered before the API alpha gate.
    '/api/browser-control/request', // NNA child-secret callback, registered before the API gate.
    '/api/agent-tool/callback', // NNA child-secret callback, registered before the API gate.
  ]);
  const uncovered: string[] = [];
  const scan = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') scan(join(directory, entry.name));
      } else if (entry.name.endsWith('.ts')) {
        const file = join(directory, entry.name);
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\bapp\.(?:post|put|patch|delete)\(\s*['"](\/api\/[^'"]+)['"]/gu)) {
          const path = match[1]!;
          if (path.startsWith('/api/terminal/')) continue; // Earlier terminal gate refuses every method.
          if (!exceptions.has(path) && !nativeAlphaMutationUnavailable('POST', path)) uncovered.push(`${file}: ${path}`);
        }
      }
    }
  };
  scan(serverRoot);
  expect(uncovered).toEqual([]);
});
