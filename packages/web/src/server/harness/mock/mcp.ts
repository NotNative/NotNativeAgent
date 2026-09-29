// SPDX-License-Identifier: Apache-2.0
/**
 * Mock harness MCP runtime (doc 02 P-14 / 6.9; doc 15 F.3). Statuses derive
 * live from the SAME config-file layers the /api/config/mcp routes write —
 * the mock stands in for a harness restart by reloading on every status read.
 * Deterministic demo rules (registered mock behavior, never invented
 * silently): a record carrying environment/header value "nnd-mock-fail"
 * reports failed; a remote record with oauth (object or discovery `{}`)
 * reports needs_auth until a token lands via the auth routes; everything
 * else connects. A manual disconnect reads back as disabled until connect.
 */
import { harnessError } from '../adapter.ts';
import { emitEvent } from './events.ts';
import { listMcpConfig, mcpNameOk, createMcpConfig, type McpResponseRecord } from '../../lib/mcp/mcp-config.ts';

export type McpMockStatus =
  | { status: 'connected' }
  | { status: 'disabled' }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth' }
  | { status: 'needs_client_registration'; error: string };

const FAIL_TOKEN = 'nnd-mock-fail';

/** Per "directory|name" live-session traces (mock side of the harness runtime). */
const disconnected = new Set<string>();
const tokensPresent = new Set<string>();
const failedServers = new Map<string, string>();

const stateKey = (directory: string, name: string): string => `${directory}|${name}`;

function hasFailToken(record: McpResponseRecord): boolean {
  return [...Object.values(record.environment ?? {}), ...Object.values(record.headers ?? {})].includes(FAIL_TOKEN);
}

function deriveStatus(directory: string, record: McpResponseRecord): McpMockStatus {
  const key = stateKey(directory, record.name);
  if (!record.enabled) return { status: 'disabled' };
  const failure = failedServers.get(key);
  if (failure !== undefined) return { status: 'failed', error: failure };
  if (hasFailToken(record)) {
    failedServers.set(key, `mock connection failed for "${record.name}"`);
    return { status: 'failed', error: `mock connection failed for "${record.name}"` };
  }
  if (record.type === 'remote' && record.oauth !== undefined && record.oauth !== false
    && !tokensPresent.has(key)) {
    return { status: 'needs_auth' };
  }
  if (disconnected.has(key)) return { status: 'disabled' };
  return { status: 'connected' };
}

async function statusMap(directory: string): Promise<Record<string, McpMockStatus>> {
  let config: Record<string, McpResponseRecord>;
  try {
    config = await listMcpConfig(directory); // live reload: stands in for the restart
  } catch {
    return {}; // malformed config layer: honest empty status; the config UI reports the file error
  }
  const map: Record<string, McpMockStatus> = {};
  for (const record of Object.values(config)) {
    failedServers.delete(stateKey(directory, record.name)); // real status supersedes any stale failure
    map[record.name] = deriveStatus(directory, record);
  }
  return map;
}

function forgetServer(directory: string, name: string): void {
  const key = stateKey(directory, name);
  disconnected.delete(key);
  tokensPresent.delete(key);
  failedServers.delete(key);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => ({}))) as unknown;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

async function knownServer(name: string, directory: string): Promise<McpResponseRecord | undefined> {
  try {
    return (await listMcpConfig(directory))[name];
  } catch {
    return undefined;
  }
}

const mapResponse = (map: Record<string, McpMockStatus>): Response =>
  new Response(JSON.stringify(map), { status: 200, headers: { 'content-type': 'application/json' } });

async function handleStatus(directory: string): Promise<Response> {
  return mapResponse(await statusMap(directory));
}

async function handleAdd(request: Request, directory: string): Promise<Response> {
  const body = await readBody(request);
  const name = typeof body.name === 'string' ? body.name : '';
  if (!mcpNameOk(name)) return harnessError('MCP server name is invalid', 400);
  try {
    await createMcpConfig(name, { ...(body.config ?? body), directory });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MCP add failed';
    return harnessError(message, /exists|duplicate/iu.test(message) ? 500 : 400);
  }
  forgetServer(directory, name);
  return mapResponse(await statusMap(directory));
}

async function handleConnect(name: string, directory: string): Promise<Response> {
  const record = await knownServer(name, directory);
  if (!record) return harnessError(`MCP server "${name}" is not configured`, 404);
  if (!record.enabled) return harnessError(`MCP server "${name}" is disabled`, 400);
  const key = stateKey(directory, name);
  if (hasFailToken(record)) failedServers.set(key, `mock connect failed for "${name}"`);
  else if (record.type === 'remote' && record.oauth !== undefined && record.oauth !== false
    && !tokensPresent.has(key)) {
    return harnessError(`MCP server "${name}" requires authentication`, 400);
  } else {
    failedServers.delete(key);
    disconnected.delete(key);
  }
  emitEvent(directory, 'mcp.tools.changed', { server: name });
  return mapResponse(await statusMap(directory));
}

async function handleDisconnect(name: string, directory: string): Promise<Response> {
  if (!await knownServer(name, directory)) return harnessError(`MCP server "${name}" is not configured`, 404);
  disconnected.add(stateKey(directory, name));
  return mapResponse(await statusMap(directory));
}

async function handleAuthStart(name: string, directory: string): Promise<Response> {
  const record = await knownServer(name, directory);
  if (!record) return harnessError(`MCP server "${name}" is not configured`, 404);
  if (record.type !== 'remote') return harnessError('only remote servers support OAuth', 400);
  const redirect = record.oauth && typeof record.oauth === 'object' ? record.oauth.redirectUri ?? '' : '';
  const separator = redirect.includes('?') ? '&' : '?';
  const authorizationUrl = redirect === ''
    ? `https://mock-oauth.test/authorize?state=nndmock&mcp=${encodeURIComponent(name)}`
    : `${redirect}${separator}state=nndmock&code=nnd-mock-code`;
  return new Response(JSON.stringify({ authorizationUrl }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

async function handleAuthCallback(name: string, request: Request, directory: string): Promise<Response> {
  if (!await knownServer(name, directory)) return harnessError(`MCP server "${name}" is not configured`, 404);
  const body = await readBody(request);
  if (typeof body.code !== 'string' || body.code === '') return harnessError('authorization code is required', 400);
  const key = stateKey(directory, name);
  tokensPresent.add(key);
  failedServers.delete(key);
  disconnected.delete(key);
  emitEvent(directory, 'mcp.tools.changed', { server: name });
  return mapResponse(await statusMap(directory));
}

async function handleAuthenticate(name: string, directory: string): Promise<Response> {
  const record = await knownServer(name, directory);
  if (!record) return harnessError(`MCP server "${name}" is not configured`, 404);
  if (record.type !== 'remote') return harnessError('only remote servers support OAuth', 400);
  // The real flow blocks for the whole browser sign-in (15-min budget); the
  // mock completes instantly so the UI path stays exercisable.
  tokensPresent.add(stateKey(directory, name));
  failedServers.delete(stateKey(directory, name));
  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

async function handleAuthRemove(name: string, directory: string): Promise<Response> {
  if (!await knownServer(name, directory)) return harnessError(`MCP server "${name}" is not configured`, 404);
  const key = stateKey(directory, name);
  tokensPresent.delete(key);
  disconnected.add(key); // doc 15 F.3: removing tokens does not touch the live session
  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

const MCP_CONNECT = /^\/mcp\/([^/]+)\/connect$/u;
const MCP_DISCONNECT = /^\/mcp\/([^/]+)\/disconnect$/u;
const MCP_AUTH_START = /^\/mcp\/([^/]+)\/auth$/u;
const MCP_AUTH_CALLBACK = /^\/mcp\/([^/]+)\/auth\/callback$/u;
const MCP_AUTHENTICATE = /^\/mcp\/([^/]+)\/auth\/authenticate$/u;

/** Captured server name for a matching pattern (undefined = not owned, null = invalid name). */
function ownedName(pattern: RegExp, path: string): string | null | undefined {
  const match = pattern.exec(path);
  if (!match) return undefined;
  const name = decodeURIComponent(match[1]!);
  return mcpNameOk(name) ? name : null;
}

/** Harness-proxied MCP routes; returns null when the path is not MCP-owned. */
export async function mcpRoute(
  request: Request, path: string, directory: string,
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (path === '/mcp') {
    if (method === 'GET') return handleStatus(directory);
    if (method === 'POST') return handleAdd(request, directory);
    return harnessError('Method not allowed', 405);
  }
  const invalidName = harnessError('MCP server name is invalid', 400);
  const wrongMethod = harnessError('Method not allowed', 405);
  for (const [pattern, action] of [
    [MCP_CONNECT, 'connect'], [MCP_DISCONNECT, 'disconnect'], [MCP_AUTH_START, 'auth'],
    [MCP_AUTH_CALLBACK, 'callback'], [MCP_AUTHENTICATE, 'authenticate'],
  ] as [RegExp, string][]) {
    const name = ownedName(pattern, path);
    if (name === undefined) continue;
    if (name === null) return invalidName;
    if (action === 'connect') return method === 'POST' ? handleConnect(name, directory) : wrongMethod;
    if (action === 'disconnect') return method === 'POST' ? handleDisconnect(name, directory) : wrongMethod;
    if (action === 'authenticate') return method === 'POST' ? handleAuthenticate(name, directory) : wrongMethod;
    if (action === 'callback') return method === 'POST' ? handleAuthCallback(name, request, directory) : wrongMethod;
    if (method === 'POST') return handleAuthStart(name, directory);
    if (method === 'DELETE') return handleAuthRemove(name, directory);
    return wrongMethod;
  }
  return null;
}

/** Test/maintenance seam: drop all live-session traces (config files untouched). */
export function resetMockMcp(): void {
  disconnected.clear();
  tokensPresent.clear();
  failedServers.clear();
}
