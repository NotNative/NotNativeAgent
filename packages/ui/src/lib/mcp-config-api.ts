// SPDX-License-Identifier: Apache-2.0
/**
 * MCP config-layer client (doc 15 F.1/F.2, P10-45): the /api/config/mcp
 * family over the app origin via runtimeFetch. Envelope matches the snippet
 * client (200 gains ok:true; failures fold to { ok:false, status, error }
 * with the server string verbatim). Mutations answer the deferred-restart
 * payload — the caller refetches with force and shows the restart hint.
 */
import { runtimeFetch } from './runtime-fetch.ts';

export interface McpConfigRecord {
  name: string;
  scope: 'user' | 'project';
  type: 'local' | 'remote';
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: Record<string, string> | false;
  timeout?: number;
  enabled: boolean;
}

export interface McpMutationResult {
  requiresReload: boolean; requiresRestart: boolean; restartDeferred?: boolean;
  requiresManualRestart?: boolean; message: string; warning?: string; reloadDelayMs?: number;
}

export type McpFailure = { ok: false; status: number; error: string };
export type McpEnvelope<T> = (T & { ok: true }) | McpFailure;

async function apiJson<T>(path: string, directory: string | undefined, init?: RequestInit): Promise<McpEnvelope<T>> {
  const query = directory ? (path.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(directory) : '';
  const response = await runtimeFetch(path + query, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: typeof body.error === 'string' ? body.error : 'MCP configuration request failed (' + response.status + ')',
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

const named = (name: string): string => '/api/config/mcp/' + encodeURIComponent(name);

export function listMcpConfigs(directory?: string): Promise<McpEnvelope<{ mcp: Record<string, McpConfigRecord> }>> {
  return apiJson('/api/config/mcp', directory);
}

export function getMcpConfig(name: string, directory?: string): Promise<McpEnvelope<McpConfigRecord>> {
  return apiJson(named(name), directory);
}

export function createMcpConfig(name: string, entry: Record<string, unknown>, directory?: string):
  Promise<McpEnvelope<McpMutationResult>> {
  return apiJson(named(name), directory, json('POST', entry));
}

export function patchMcpConfig(name: string, patch: Record<string, unknown>, directory?: string):
  Promise<McpEnvelope<McpMutationResult>> {
  return apiJson(named(name), directory, json('PATCH', patch));
}

export function deleteMcpConfig(name: string, directory?: string): Promise<McpEnvelope<McpMutationResult>> {
  return apiJson(named(name), directory, { method: 'DELETE' });
}
