// SPDX-License-Identifier: Apache-2.0
/**
 * Files client (doc 06 §2.1/§3.3): the fs REST surface the FilesView reads
 * through runtimeFetch. The doc's RuntimeAPIs.files delegation is the
 * runtime adapter contract (delta E-06-2: the web build talks to the server
 * routes directly; the adapter indirection lands with the desktop shell).
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { getApiBaseUrl } from '../runtime-url.ts';
import { getCurrentUrlToken } from '../runtime-auth.ts';

export interface FsEntry { name: string; path: string; isDirectory: boolean; isFile?: boolean }

export async function listDirectory(directory: string, path = '.', force = false): Promise<FsEntry[]> {
  const suffix = force ? '&force=true' : '';
  const response = await runtimeFetch(`/api/fs/list?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}${suffix}`);
  if (!response.ok) throw new Error(await readError(response) ?? 'Directory not found');
  const body = await response.json() as { entries?: FsEntry[] };
  return Array.isArray(body.entries) ? body.entries : [];
}

export async function searchWorkspaceFiles(directory: string, query: string, limit = 150): Promise<FsEntry[]> {
  const url = `/api/fs/search?directory=${encodeURIComponent(directory)}&query=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await runtimeFetch(url);
  if (!response.ok) return [];
  const body = await response.json() as { entries?: FsEntry[] };
  return Array.isArray(body.entries) ? body.entries : [];
}

export interface FileStat { path: string; isFile: boolean; exists?: boolean; size: number; mtimeMs: number }

export class FileReadError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) { super(message); this.name = 'FileReadError'; }
}

export class FileWriteConflictError extends Error {
  constructor(message: string, readonly safety: 'changed' | 'unknown' = 'changed') { super(message); this.name = 'FileWriteConflictError'; }
}

export async function readFileStat(directory: string, path: string, optional = false): Promise<FileStat | null> {
  const optionalFlag = optional ? '&optional=true' : '';
  const response = await runtimeFetch(`/api/fs/stat?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}${optionalFlag}`);
  if (!response.ok) return null;
  return await response.json() as FileStat;
}

/** Read a UTF-8 file. `fresh` maps to no-store (§3.5 content poll). */
export async function readFileText(directory: string, path: string, fresh = false): Promise<string> {
  const headers = fresh ? { 'cache-control': 'no-store' } : undefined;
  const response = await runtimeFetch(`/api/fs/read?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}`, { headers });
  if (!response.ok) {
    const detail = await readErrorDetails(response);
    throw new FileReadError(detail.error ?? 'Failed to read file', response.status, detail.reason);
  }
  return await response.text();
}

export async function writeFileText(directory: string, path: string, content: string, expectedContent?: string): Promise<void> {
  const response = await runtimeFetch(`/api/fs/write?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content, ...(expectedContent === undefined ? {} : { expectedContent }) }),
  });
  if (!response.ok) {
    const detail = await readErrorDetails(response);
    if (response.status === 409 && detail.reason === 'content-conflict') {
      throw new FileWriteConflictError(detail.error ?? 'File changed since it was opened', detail.safety === 'unknown' ? 'unknown' : 'changed');
    }
    throw new Error(detail.error ?? 'Failed to write file');
  }
}

/** Binary asset URL for <img>/download (P6-1 web slice: same-origin asset). */
export function rawAssetUrl(directory: string, path: string, download = false): string {
  const suffix = download ? '&download=true' : '';
  const token = getCurrentUrlToken();
  const auth = token ? `&nn_url_token=${encodeURIComponent(token)}` : '';
  return `${getApiBaseUrl()}/api/fs/raw?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(path)}${suffix}${auth}`;
}

export async function createDirectory(directory: string, path: string): Promise<void> {
  const response = await runtimeFetch(`/api/fs/mkdir?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new Error(await readError(response) ?? 'Failed to create folder');
}

export async function deleteEntry(directory: string, path: string): Promise<void> {
  const response = await runtimeFetch(`/api/fs/delete?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok) throw new Error(await readError(response) ?? 'Failed to delete');
}

export async function renameEntry(directory: string, oldPath: string, newPath: string): Promise<void> {
  const response = await runtimeFetch(`/api/fs/rename?directory=${encodeURIComponent(directory)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  if (!response.ok) throw new Error(await readError(response) ?? 'Failed to rename');
}

async function readError(response: Response): Promise<string | null> {
  return (await readErrorDetails(response)).error;
}

async function readErrorDetails(response: Response): Promise<{ error: string | null; reason?: string; safety?: string }> {
  try {
    const body = await response.clone().json() as { error?: string; reason?: string; safety?: string };
    return { error: typeof body.error === 'string' ? body.error : null,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      safety: typeof body.safety === 'string' ? body.safety : undefined };
  } catch {
    return { error: null };
  }
}
