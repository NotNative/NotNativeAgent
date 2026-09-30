// SPDX-License-Identifier: Apache-2.0
/** §G.6 prepared local-image access for assistant markdown. */

import { rawAssetUrl } from '../lib/files/api.ts';

const READY_CACHE_MS = 60_000;

export type PreparedMarkdownImage =
  | { state: 'ready'; src: string; expiresAt: number }
  | { state: 'unavailable' };

interface PrepareInput {
  directory: string;
  messageId: string;
  sessionId: string;
  sources: readonly string[];
}

type RuntimeAssets = Map<string, PreparedMarkdownImage>;
const preparedRuntime = new Map<string, { expiresAt: number; images: Map<string, PreparedMarkdownImage> }>();

export async function prepareLocalMarkdownImages(
  input: PrepareInput,
  now: () => number = defaultNow,
  request: (url: string, init: RequestInit) => Promise<Response> = defaultRequest,
): Promise<RuntimeAssets> {
  const key = requestRuntimeKey() + '\n' + JSON.stringify([input.directory, input.messageId, input.sessionId, [...input.sources].sort()]);
  const cached = preparedRuntime.get(key);
  if (cached !== undefined) {
    if (cached.expiresAt > now()) return cached.images;
    preparedRuntime.delete(key);
  }

  const images = new Map<string, PreparedMarkdownImage>();
  for (const source of input.sources) images.set(source, { state: 'unavailable' });
  try {
    const response = await request('/api/openchamber/sessions/' + encodeURIComponent(input.sessionId) + '/markdown-image-grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: input.directory, messageId: input.messageId, sources: [...input.sources] }),
    });
    if (!response.ok) return images;
    const result = await safeResult(response);
    if (result === null) return images;
  const expiresAt = minimumExpiry(result.results);
    for (const item of result.results) {
    if (item.status !== 'ready' || typeof item.path !== 'string' || typeof item.source !== 'string' || item.source === '') continue;
    const source = item.source;
    const token = typeof item.outsideFileGrant === 'string' && item.outsideFileGrant !== '' ? item.outsideFileGrant : null;
    const itemExpiry = expiryOf(item) ?? now() + READY_CACHE_MS;
    const src = token === null ? rawAssetUrl(input.directory, item.path) : rawOutsideAssetUrl(item.path, token);
    images.set(source, { state: 'ready', src, expiresAt: token === null ? itemExpiry : Math.min(itemExpiry, expiresAt) });
  }
  preparedRuntime.set(key, { expiresAt: Math.min(expiresAt, now() + READY_CACHE_MS), images });
  } catch {
    return images;
  }
  return images;
}

export function resetMarkdownImageAssets(): void {
  preparedRuntime.clear();
}

function safeResult(response: Response): Promise<{ results: Array<Record<string, unknown>> } | null> {
  return response.json().then((value) => {
    return value !== null
      && typeof value === 'object'
      && Array.isArray((value as { results?: unknown }).results)
      ? value as { results: Array<Record<string, unknown>> }
      : null;
  }).catch(() => null);
}

function itemStatus(item: Record<string, unknown>): string | null {
  return typeof item.status === 'string' ? item.status : null;
}

function numeric(item: Record<string, unknown>, field: string): number | null {
  const value = item[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function expiryOf(item: Record<string, unknown>): number | null {
  return numeric(item, 'expiresAt');
}

function minimumExpiry(results: readonly Record<string, unknown>[]): number {
  let minimum = Number.MAX_SAFE_INTEGER;
  for (const item of results) {
    if (itemStatus(item) !== 'ready') continue;
    const expiresAt = expiryOf(item);
    if (expiresAt !== null) minimum = Math.min(minimum, expiresAt);
  }
  return minimum;
}

function rawOutsideAssetUrl(path: string, token: string): string {
  return '/api/fs/raw?path=' + encodeURIComponent(path) + '&allowOutsideWorkspace=true&outsideFileGrant=' + encodeURIComponent(token);
}

function requestRuntimeKey(): string {
  try { return globalThis.location.origin ?? ''; } catch { return 'none'; }
}

function defaultNow(): number { return Date.now(); }
function defaultRequest(url: string, init: RequestInit): Promise<Response> { return fetch(url, init); }
