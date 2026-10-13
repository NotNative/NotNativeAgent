// SPDX-License-Identifier: Apache-2.0
/**
 * Snippet config-entity client (doc 03 §5.x "Snippets", P9-4e-i): the
 * /api/config/snippets family over the app origin via runtimeFetch. The
 * envelope mirrors the scheduled-task client: 200 bodies gain `ok: true`
 * when the server did not stamp one; failures fold to
 * `{ ok: false, status, error }` with the server's error string (or a
 * generic fallback). `POST /expand` answers `{ text }` — the SAME
 * keep-unknown-tokens rule the composer's local expansion rides.
 */
import { runtimeFetch } from './runtime-fetch.ts';

export interface SnippetRecord {
  name: string;
  text: string;
  scope?: string;
  [key: string]: unknown;
}

export type SnippetFailure = { ok: false; status: number; error: string };
export type SnippetEnvelope<T> = (T & { ok: true }) | SnippetFailure;

const SNIPPET_NAME = /^[\w-]{1,64}$/u;

export function snippetRecords(value: unknown): value is SnippetRecord[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  return value.every((entry): entry is SnippetRecord => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as SnippetRecord;
    if (typeof record.name !== 'string' || !SNIPPET_NAME.test(record.name)) return false;
    if (typeof record.text !== 'string' || record.text === '') return false;
    if (names.has(record.name)) return false;
    names.add(record.name);
    return true;
  });
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<SnippetEnvelope<T>> {
  const response = await runtimeFetch(url, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof body.error === 'string' ? body.error : `snippet request failed (${response.status})`,
    };
  }
  const stamped = body as T & { ok?: unknown };
  return (typeof stamped.ok === 'boolean' ? stamped : { ...stamped, ok: true }) as T & { ok: true };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function listSnippets(): Promise<SnippetEnvelope<{ snippets: SnippetRecord[] }>> {
  return apiJson('/api/config/snippets');
}

export function getSnippet(name: string): Promise<SnippetEnvelope<SnippetRecord>> {
  return apiJson(`/api/config/snippets/${encodeURIComponent(name)}`);
}

export function createSnippet(name: string, snippet: { text: string; scope?: string } & Record<string, unknown>):
  Promise<SnippetEnvelope<{ success: true; snippet: SnippetRecord }>> {
  return apiJson(`/api/config/snippets/${encodeURIComponent(name)}`, json('POST', snippet));
}

export function patchSnippet(name: string, patch: { text?: string; scope?: string } & Record<string, unknown>):
  Promise<SnippetEnvelope<{ success: true; snippet: SnippetRecord }>> {
  return apiJson(`/api/config/snippets/${encodeURIComponent(name)}`, json('PATCH', patch));
}

export function deleteSnippet(name: string): Promise<SnippetEnvelope<{ success: true }>> {
  return apiJson(`/api/config/snippets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** Server-side `#name` expansion over the stored roster (same unknown-token
 * keeps-its-bytes rule as the composer's local expansion). */
export function expandSnippet(text: string): Promise<SnippetEnvelope<{ text: string }>> {
  return apiJson('/api/config/snippets/expand', json('POST', { text }));
}
