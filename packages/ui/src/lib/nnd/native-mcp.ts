// SPDX-License-Identifier: Apache-2.0
/** Redacted NNA MCP user-manifest contract. Private fields never cross this client. */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration/mcp';
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const DEADLINES = ['timeout_ms', 'connect_timeout_ms', 'list_timeout_ms', 'call_timeout_ms', 'shutdown_timeout_ms'] as const;
export type NativeMcpDeadline = typeof DEADLINES[number];
export interface NativeMcpServer { id: string; transport: 'stdio' | 'streamable_http'; enabled: boolean; trusted: boolean;
  timeout_ms?: number; connect_timeout_ms?: number; list_timeout_ms?: number; call_timeout_ms?: number; shutdown_timeout_ms?: number }
export interface NativeMcpView { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'present'; source_revision: string; resolution_revision: string; project_shadowed: boolean;
  application: 'not_applied'; servers: NativeMcpServer[] }
export type NativeMcpChange = { op: 'delete'; id: string }
  | { op: 'patch'; id: string; fields: { enabled?: boolean } & Partial<Record<NativeMcpDeadline, number>> }
  | { op: 'create'; id: string; fields: { transport: 'stdio'; command: string; args?: string[] }
    | { transport: 'streamable_http'; endpoint: string } };
export interface NativeMcpRequest { installation_id: string; data_id: string; scope: 'user'; expected_revision: string;
  expected_resolution_revision: string; change: NativeMcpChange }
export interface NativeMcpReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; persisted_revision: string | null; before_revision: string;
  application: 'not_applied'; replayed: boolean }
export class NativeMcpFailure extends Error { constructor(readonly code: string) { super(code); } }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => new NativeMcpFailure('nnd_mcp_view_invalid');

function parseServer(value: unknown): NativeMcpServer {
  if (!record(value) || typeof value.id !== 'string' || !ID.test(value.id)
    || !['stdio', 'streamable_http'].includes(String(value.transport))
    || typeof value.enabled !== 'boolean' || typeof value.trusted !== 'boolean'
    || Object.keys(value).some(key => !['id', 'transport', 'enabled', 'trusted', ...DEADLINES].includes(key))) throw fail();
  for (const key of DEADLINES) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) throw fail();
  return value as unknown as NativeMcpServer;
}
export function parseNativeMcpView(value: unknown): NativeMcpView {
  if (!record(value) || value.schema_version !== '1.0' || value.scope !== 'user'
    || typeof value.installation_id !== 'string' || !IDENTITY.test(value.installation_id)
    || typeof value.data_id !== 'string' || !IDENTITY.test(value.data_id)
    || value.source_state !== 'present' || typeof value.source_revision !== 'string' || !REVISION.test(value.source_revision)
    || typeof value.resolution_revision !== 'string' || !REVISION.test(value.resolution_revision)
    || typeof value.project_shadowed !== 'boolean' || value.application !== 'not_applied'
    || !Array.isArray(value.servers) || value.servers.length > 16) throw fail();
  const servers = value.servers.map(parseServer);
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw fail();
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: 'user', source_state: 'present', source_revision: value.source_revision,
    resolution_revision: value.resolution_revision, project_shadowed: value.project_shadowed,
    application: 'not_applied', servers };
}
function parseReceipt(value: unknown, identity: { installation_id: string; data_id: string }, operationId: string,
  expectedRevision?: string): NativeMcpReceipt {
  if (!record(value) || value.installation_id !== identity.installation_id || value.data_id !== identity.data_id
    || value.scope !== 'user' || value.operation_id !== operationId || !['saved', 'unpublished', 'unknown'].includes(String(value.persistence))
    || !(value.persisted_revision === null || typeof value.persisted_revision === 'string' && REVISION.test(value.persisted_revision))
    || typeof value.before_revision !== 'string' || !REVISION.test(value.before_revision)
    || expectedRevision !== undefined && value.before_revision !== expectedRevision
    || value.persistence === 'saved' && value.persisted_revision === null
    || value.application !== 'not_applied' || typeof value.replayed !== 'boolean') throw fail();
  return { installation_id: value.installation_id as string, data_id: value.data_id as string,
    scope: 'user', operation_id: value.operation_id as string,
    persistence: value.persistence as NativeMcpReceipt['persistence'],
    persisted_revision: value.persisted_revision as string | null,
    before_revision: value.before_revision as string, application: 'not_applied', replayed: value.replayed as boolean };
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw fail();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) {
    const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw fail(); }
    chunks.push(item.value);
  } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fail(); }
}
async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > 65536) throw new NativeMcpFailure('nnd_mcp_request_invalid');
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? error.code : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
        : response.status === 404 ? 'nnd_mcp_unsupported' : 'nnd_mcp_unavailable';
    throw new NativeMcpFailure(code);
  }
  return payload;
}
export async function readNativeMcp(signal: AbortSignal): Promise<NativeMcpView> {
  return parseNativeMcpView(await call('', 'GET', signal));
}
export function nativeMcpRequest(view: NativeMcpView, change: NativeMcpChange): NativeMcpRequest {
  if (view.project_shadowed || !ID.test(change.id)) throw new NativeMcpFailure('nnd_mcp_request_invalid');
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision, change };
}
export async function previewNativeMcp(request: NativeMcpRequest, signal: AbortSignal): Promise<NativeMcpView> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'not_applied'
    || raw.expected_revision !== request.expected_revision || raw.resolution_revision !== request.expected_resolution_revision
    || !record(raw.change) || raw.change.op !== request.change.op || raw.change.id !== request.change.id) throw fail();
  const view = parseNativeMcpView(raw.view);
  if (view.installation_id !== request.installation_id || view.data_id !== request.data_id) throw fail();
  return view;
}
export async function saveNativeMcp(request: NativeMcpRequest, operationId: string, signal: AbortSignal): Promise<NativeMcpReceipt> {
  if (authorityState() !== 'ready' || !ID.test(operationId)) throw new NativeMcpFailure('nnd_mcp_unavailable');
  return parseReceipt(await call('/save', 'POST', signal, { ...request, operation_id: operationId }), request,
    operationId, request.expected_revision);
}
export async function inspectNativeMcpOperation(identity: { installation_id: string; data_id: string }, operationId: string,
  signal: AbortSignal): Promise<NativeMcpReceipt | null> {
  if (!ID.test(operationId)) throw new NativeMcpFailure('nnd_mcp_request_invalid');
  try { return parseReceipt(await call(`/operations/${operationId}`, 'GET', signal), identity, operationId); }
  catch (error) { if (error instanceof NativeMcpFailure && error.code === 'operation_not_found') return null; throw error; }
}
