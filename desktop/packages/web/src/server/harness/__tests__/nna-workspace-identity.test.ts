import { describe, expect, it, vi } from 'vitest';
import { readNnaPrimaryWorkspaceId } from '../nna-workspace-identity.ts';

const id = `ws_${'a'.repeat(24)}`;
const other = `ws_${'b'.repeat(24)}`;
const path = { directory: 'D:\\Repos\\A', worktree: 'D:\\Repos\\A', workspace_id: id };

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function reader(catalog: Response, nativePath = response(path)) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret', 'x-nna-principal': 'operator' });
    return String(url).endsWith('/v1/nnd/workspaces') ? catalog : nativePath;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, read: () => readNnaPrimaryWorkspaceId({ endpoint: 'http://127.0.0.1:1234/', token: 'secret', principal: 'operator', fetch }) };
}

describe('NNA primary workspace identity', () => {
  it('uses the catalog only when the authenticated path agrees', async () => {
    const fixture = reader(response({ primary: { root: 'd:\\repos\\a', id }, selection_enabled: false }));
    await expect(fixture.read()).resolves.toBe(id);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a valid catalog with two long workspace roots', async () => {
    const root = `D:/${'a/'.repeat(1800)}a`.replaceAll('/', '\\');
    const catalog = { primary: { root, id }, secondary: { root: `D:/${'b/'.repeat(1800)}b`.replaceAll('/', '\\'), id: other },
      selection_enabled: false };
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeGreaterThan(8192);
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeLessThan(16 * 1024);
    await expect(reader(response(catalog), response({ directory: root, worktree: root, workspace_id: id })).read())
      .resolves.toBe(id);
  });

  it('falls back to NNA-authored /path identity only when the catalog route is absent', async () => {
    await expect(reader(response({ error: { code: 'not_found' } }, 404)).read()).resolves.toBe(id);
    await expect(reader(response({ error: { code: 'nnd_workspace_grant_unavailable' } }, 500)).read()).resolves.toBe(id);
    await expect(reader(response({}, 403)).read()).resolves.toBeNull();
    await expect(reader(response({ error: { code: 'internal_failure' } }, 500)).read()).resolves.toBeNull();
    await expect(reader(response({ primary: { root: path.directory, id: other }, selection_enabled: false })).read()).resolves.toBeNull();
  });

  it('fails closed on missing or malformed identity, changed path, or secondary selection', async () => {
    const missingCatalog = response({ error: { code: 'not_found' } }, 404);
    await expect(reader(missingCatalog, response({ ...path, workspace_id: undefined })).read()).resolves.toBeNull();
    await expect(reader(response({ error: { code: 'not_found' } }, 404), response({ ...path, workspace_id: 'local' })).read()).resolves.toBeNull();
    await expect(reader(response({ primary: { root: 'D:\\Repos\\B', id }, selection_enabled: false })).read()).resolves.toBeNull();
    await expect(reader(response({ primary: { root: path.directory, id }, selection_enabled: true })).read()).resolves.toBeNull();
    await expect(reader(response({ primary: { root: path.directory, id }, selection_enabled: false }), response({ ...path, worktree: 'D:\\Repos\\B' })).read()).resolves.toBeNull();
  });
});
