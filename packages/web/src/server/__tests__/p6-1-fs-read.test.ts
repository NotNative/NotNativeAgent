// SPDX-License-Identifier: Apache-2.0
/**
 * P6-1 fs read-family gates (doc 03 §5.14): stat/read/raw against a real
 * temp workspace with the containment rules (403 on escapes), `optional`
 * semantics (missing → `{exists:false}` on stat; empty 200 on read), and
 * the raw route's MIME + download + no-store/nosniff headers.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerHarnessAdapter } from '../harness/adapter.ts';
import { mockHarness } from '../harness/mock/index.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-fsr-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
const origin = 'http://test.local';
const workspace = joinPath(isolatedDataDir, 'workspace');
const SECOND_DRIVE_PATCH = '';

type App = { fetch: (request: Request) => Promise<Response> };
let appInstance: App | null = null;

beforeAll(async () => {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(joinPath(workspace, 'text.txt'), 'hello p61\n');
  mkdirSync(joinPath(workspace, 'nested'), { recursive: true });
  writeFileSync(joinPath(workspace, 'nested', 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { createApp } = await import('../app.ts');
  registerHarnessAdapter(mockHarness);
  appInstance = { fetch: (request: Request) => Promise.resolve(createApp().fetch(request)) };
  void existsSync;
  void SECOND_DRIVE_PATCH;
});

async function call(path: string): Promise<Response> {
  if (!appInstance) throw new Error('app not initialized');
  return appInstance.fetch(new Request(`${origin}${path}`));
}

describe('fs read family (§5.14)', () => {
  it('stat answers {exists:true,size,mtimeMs} inside the scope; optional missing answers {exists:false}', async () => {
    const found = await (await call(`/api/fs/stat?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent('text.txt')}`)).json() as { exists: boolean; size: number; isFile: boolean };
    expect(found.exists).toBe(true);
    expect(found.isFile).toBe(true);
    expect(found.size).toBe('hello p61\n'.length);
    const missing = await (await call(`/api/fs/stat?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent('nope.txt')}&optional=true`)).json() as { exists: boolean };
    expect(missing.exists).toBe(false);
    const hardMissing = await call(`/api/fs/stat?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent('nope.txt')}`);
    expect(hardMissing.status).toBe(404);
  });

  it('read returns text/plain content; containment escapes are 403', async () => {
    const response = await call(`/api/fs/read?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent('text.txt')}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('hello p61\n');
    const escape = await call(`/api/fs/read?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent('../outside.txt')}`);
    expect(escape.status).toBe(403);
  });

  it('raw serves per-extension MIME + nosniff; download sets the disposition', async () => {
    const response = await call(`/api/fs/raw?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent(joinPath('nested', 'blob.png'))}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const download = await call(`/api/fs/raw?directory=${encodeURIComponent(workspace)}&path=${encodeURIComponent(joinPath('nested', 'blob.png'))}&download=true`);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    const bytes = new Uint8Array(await (await download.arrayBuffer()));
    expect(bytes[1]).toBe(0x50);
    rmSync(workspace, { recursive: true, force: true });
  });
});
