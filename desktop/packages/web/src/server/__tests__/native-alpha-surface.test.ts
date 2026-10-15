// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { nativeAlphaMutationUnavailable } from '../routes/native-alpha-surface.ts';
import { BrowserControlBroker } from '../preview/browser-control-broker.ts';

afterEach(() => vi.unstubAllEnvs());

it('closes NND-owned mutations but leaves native chat, setup, review, and reads available', () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  for (const path of ['/api/fs/write', '/api/git/commit', '/api/git/worktrees',
    '/api/message-queue/sessions/s1/items', '/api/projects/p1/scheduled-tasks/task/run',
    '/api/project-context/p1/notes', '/api/config/skills/install', '/api/openchamber/tunnel/start',
    '/api/notnative/update-install', '/api/openchamber/update-install',
    '/api/agent-tool/callback']) {
    expect(nativeAlphaMutationUnavailable('POST', path), path).toBe(true);
  }
  for (const path of ['/api/session', '/api/session/s1/prompt_async', '/api/file',
    '/api/permission/p1/reply', '/api/v1/nnd/setup/activate', '/api/v1/nnd/configuration',
    '/api/browser-control/request', '/api/workspace-presentation', '/api/workspace-default', '/api/conversation-drafts', '/api/workspace-preferences']) {
    expect(nativeAlphaMutationUnavailable('POST', path), path).toBe(false);
  }
  expect(nativeAlphaMutationUnavailable('GET', '/api/git/status')).toBe(false);
  expect(nativeAlphaMutationUnavailable('POST', '/api/github')).toBe(false);
});

it('refuses installed Git, file, and queue mutations before their handlers run', async () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  const app = createApp();
  for (const path of ['/api/fs/write', '/api/git/commit', '/api/message-queue/sessions/s1/items',
    '/api/openchamber/update-install']) {
    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status, path).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'native_alpha_surface_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

it('refuses authenticated private callbacks before NND-owned effects in the native alpha', async () => {
  vi.stubEnv('NOTNATIVE_RUNTIME', 'service');
  vi.stubEnv('NOTNATIVE_HARNESS', 'nna');
  const broker = new BrowserControlBroker();
  const app = createApp({ browserControl: broker, browserCallbackSecret: 'browser-secret',
    agentToolCallbackSecret: 'agent-secret' });
  expect((await app.request('/api/browser-control/request', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  expect((await app.request('/api/agent-tool/callback', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  const browser = await app.request('/api/browser-control/request', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nnd-browser-token': 'browser-secret' },
    body: JSON.stringify({ action: 'browser.open', parameters: { url: 'https://example.org/' } }) });
  // The token-authenticated desktop browser bridge is governed on the NNA
  // tool side; the alpha closure no longer blocks its dispatch.
  expect(browser.status).toBe(503);
  expect(await browser.json()).toMatchObject({ error: 'No capable desktop browser is connected; nothing was changed.' });
  const memory = await app.request('/api/agent-tool/callback', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer agent-secret' },
    body: JSON.stringify({ tool: 'openchamber_memory', input: { action: 'memory.save', parameters: {
      title: 'Would mutate', body: 'denied', scope: 'global' } } }) });
  expect(memory.status).toBe(409);
  expect(await memory.json()).toMatchObject({ code: 'native_alpha_surface_unavailable' });
  broker.dispose();
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
    '/api/system/probe-url', // Read-only loopback reachability probe for the browser bridge guest.
    '/api/agent-tool/callback', // NNA child-secret callback, registered before the API gate.
    '/api/workspace-preferences', // Authenticated sidebar presentation only.
    '/api/conversation-drafts', // Authenticated draft storage; native admission remains separate.
    '/api/workspace-presentation', // Authenticated display names and visibility; no execution authority.
    '/api/workspace-default', // First-use folder inside the service data root; native admission remains separate.
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
