// SPDX-License-Identifier: Apache-2.0
/** Reads only NNA-authored primary identity. A browser path or NND setting cannot mint workspace scope. */
const WORKSPACE_ID = /^ws_[a-f0-9]{24}$/u;
// Both /path and the grant catalog may carry two escaped 4 KiB Windows roots.
const PATH_BYTES = 16 * 1024;
const CATALOG_BYTES = 16 * 1024;
const DEADLINE_MS = 5000;

type NativePath = { directory?: unknown; worktree?: unknown; workspace_id?: unknown };
type NativeCatalog = { primary?: { root?: unknown; id?: unknown }; selection_enabled?: unknown };
type NativeError = { error?: { code?: unknown } };

function directoryKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('//') || normalized.includes('//') || normalized.split('/').some(part => part === '.' || part === '..')) return null;
  if (/^[A-Za-z]:\//u.test(normalized)) return normalized.toLowerCase().replace(/\/+$/u, '');
  return normalized.startsWith('/') ? normalized.replace(/\/+$/u, '') : null;
}

async function boundedJson(response: Response, limit = PATH_BYTES): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.length;
    if (size > limit) { await reader.cancel(); throw new Error('oversized identity'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export async function readNnaPrimaryWorkspaceId(options: {
  endpoint: string; token: string; principal: string; fetch?: typeof fetch; signal?: AbortSignal;
}): Promise<string | null> {
  const requestFetch = options.fetch ?? globalThis.fetch;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(DEADLINE_MS)]) : AbortSignal.timeout(DEADLINE_MS);
  const headers = { authorization: `Bearer ${options.token}`, 'x-nna-principal': options.principal };
  const get = (path: string) => requestFetch(new URL(path, options.endpoint), { method: 'GET', headers, redirect: 'error', signal });
  try {
    const catalogResponse = await get('/v1/nnd/workspaces');
    let catalog: NativeCatalog | null = null;
    if (catalogResponse.ok) catalog = await boundedJson(catalogResponse, CATALOG_BYTES) as NativeCatalog;
    else {
      if (catalogResponse.status !== 404 && catalogResponse.status !== 500 && catalogResponse.status !== 503) return null;
      const failure = await boundedJson(catalogResponse) as NativeError;
      const unavailable = failure?.error?.code === 'nnd_workspace_grant_unavailable';
      if (!unavailable && (catalogResponse.status !== 404 || failure?.error?.code !== 'not_found')) return null;
    }
    const pathResponse = await get('/path');
    if (!pathResponse.ok) return null;
    const path = await boundedJson(pathResponse) as NativePath;
    const directory = directoryKey(path?.directory);
    if (!directory || directory !== directoryKey(path?.worktree)) return null;
    if (catalog !== null) {
      const root = directoryKey(catalog?.primary?.root), id = catalog?.primary?.id;
      if (catalog.selection_enabled !== false || root !== directory || typeof id !== 'string' || !WORKSPACE_ID.test(id)) return null;
      if (path.workspace_id !== undefined && path.workspace_id !== id) return null;
      return id;
    }
    return typeof path.workspace_id === 'string' && WORKSPACE_ID.test(path.workspace_id) ? path.workspace_id : null;
  } catch { return null; }
}
