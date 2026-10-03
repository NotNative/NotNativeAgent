// SPDX-License-Identifier: Apache-2.0
/** Narrow, redacted NNA gateway timeout contract. The token and authority fields are never modeled here. */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration/gateway';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new NativeGatewayFailure('nnd_gateway_timeout_view_invalid');
const timeout = (value: unknown): value is number => Number.isInteger(value) && typeof value === 'number' && value >= 5 && value <= 50;
export class NativeGatewayFailure extends Error { constructor(readonly code: string) { super(code); } }
export interface NativeGatewayView { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'present'; source_revision: string; resolution_revision: string; project_shadowed: false;
  polling_timeout_seconds: number; application: 'not_applied' }
export interface NativeGatewayCatalog { schema_version: '1.0'; source: 'gateway'; scope: 'user';
  fields: [{ path: 'polling_timeout_seconds'; classification: 'operator_setting'; type: 'integer';
    minimum: 5; maximum: 50; application: 'restart_gateway'; editability: { available: true;
      scope: 'user'; required_permission: 'nnd.configuration.manage' } }] }
export interface NativeGatewayRequest { installation_id: string; data_id: string; scope: 'user';
  expected_revision: string; expected_resolution_revision: string; polling_timeout_seconds: number }
export interface NativeGatewayReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; before_revision: string; persisted_revision: string | null;
  application: 'not_applied'; next_action: 'restart_gateway' | 'inspect_native_operation'; replayed: boolean;
  replay_window: 'last_128_operations' }

export function parseNativeGatewayView(raw: unknown): NativeGatewayView {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id) || raw.scope !== 'user' || raw.source_state !== 'present'
    || typeof raw.source_revision !== 'string' || !REVISION.test(raw.source_revision)
    || raw.resolution_revision !== raw.source_revision || raw.project_shadowed !== false
    || !timeout(raw.polling_timeout_seconds) || raw.application !== 'not_applied') throw invalid();
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id, scope: 'user',
    source_state: 'present', source_revision: raw.source_revision, resolution_revision: raw.source_revision,
    project_shadowed: false, polling_timeout_seconds: raw.polling_timeout_seconds, application: 'not_applied' };
}
function parseCatalog(raw: unknown): NativeGatewayCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'gateway' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== 1) throw invalid();
  const field: unknown = raw.fields[0];
  if (!record(field) || field.path !== 'polling_timeout_seconds' || field.classification !== 'operator_setting'
    || field.type !== 'integer' || field.minimum !== 5 || field.maximum !== 50 || field.application !== 'restart_gateway'
    || !record(field.editability) || field.editability.available !== true || field.editability.scope !== 'user'
    || field.editability.required_permission !== 'nnd.configuration.manage') throw invalid();
  return { schema_version: '1.0', source: 'gateway', scope: 'user', fields: [{ path: 'polling_timeout_seconds',
    classification: 'operator_setting', type: 'integer', minimum: 5, maximum: 50, application: 'restart_gateway',
    editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } }] };
}
function parseReceipt(raw: unknown, identity: { installation_id: string; data_id: string }, operationId: string,
  expectedRevision?: string): NativeGatewayReceipt {
  if (!record(raw) || raw.installation_id !== identity.installation_id || raw.data_id !== identity.data_id
    || raw.scope !== 'user' || raw.operation_id !== operationId
    || !['saved', 'unpublished', 'unknown'].includes(String(raw.persistence))
    || typeof raw.before_revision !== 'string' || !REVISION.test(raw.before_revision)
    || expectedRevision !== undefined && raw.before_revision !== expectedRevision
    || !(raw.persisted_revision === null || typeof raw.persisted_revision === 'string' && REVISION.test(raw.persisted_revision))
    || raw.persistence === 'saved' && raw.persisted_revision === null || raw.application !== 'not_applied'
    || raw.next_action !== (raw.persistence === 'saved' ? 'restart_gateway' : 'inspect_native_operation')
    || typeof raw.replayed !== 'boolean' || raw.replay_window !== 'last_128_operations') throw invalid();
  return { installation_id: raw.installation_id as string, data_id: raw.data_id as string, scope: 'user',
    operation_id: operationId, persistence: raw.persistence as NativeGatewayReceipt['persistence'],
    before_revision: raw.before_revision as string, persisted_revision: raw.persisted_revision as string | null,
    application: 'not_applied', next_action: raw.next_action as NativeGatewayReceipt['next_action'],
    replayed: raw.replayed as boolean, replay_window: 'last_128_operations' };
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > 4096) { await reader.cancel(); throw invalid(); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
}
async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > 4096) throw new NativeGatewayFailure('nnd_gateway_timeout_request_invalid');
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? error.code : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
        : response.status === 404 ? 'nnd_gateway_timeout_unsupported' : 'nnd_gateway_timeout_unavailable';
    throw new NativeGatewayFailure(code);
  }
  return payload;
}
export async function readNativeGateway(signal: AbortSignal): Promise<NativeGatewayView> {
  return parseNativeGatewayView(await call('', 'GET', signal));
}
export async function readNativeGatewayCatalog(signal: AbortSignal): Promise<NativeGatewayCatalog> {
  return parseCatalog(await call('/catalog', 'GET', signal));
}
export function nativeGatewayRequest(view: NativeGatewayView, value: number): NativeGatewayRequest {
  if (!timeout(value) || view.project_shadowed) throw new NativeGatewayFailure('nnd_gateway_timeout_request_invalid');
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision,
    polling_timeout_seconds: value };
}
export async function previewNativeGateway(request: NativeGatewayRequest, signal: AbortSignal): Promise<NativeGatewayView> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'not_applied'
    || raw.expected_revision !== request.expected_revision || raw.resolution_revision !== request.expected_resolution_revision) throw invalid();
  const view = parseNativeGatewayView(raw.view);
  if (view.installation_id !== request.installation_id || view.data_id !== request.data_id
    || view.source_revision !== request.expected_revision || view.polling_timeout_seconds !== request.polling_timeout_seconds) throw invalid();
  return view;
}
export async function saveNativeGateway(request: NativeGatewayRequest, operationId: string,
  signal: AbortSignal): Promise<NativeGatewayReceipt> {
  if (authorityState() !== 'ready' || !OPERATION_ID.test(operationId)) throw new NativeGatewayFailure('nnd_gateway_timeout_unavailable');
  return parseReceipt(await call('/save', 'POST', signal, { ...request, operation_id: operationId }), request,
    operationId, request.expected_revision);
}
export async function inspectNativeGatewayOperation(identity: { installation_id: string; data_id: string },
  operationId: string, signal: AbortSignal): Promise<NativeGatewayReceipt | null> {
  if (!OPERATION_ID.test(operationId)) throw new NativeGatewayFailure('nnd_gateway_timeout_request_invalid');
  try { return parseReceipt(await call(`/operations/${operationId}`, 'GET', signal), identity, operationId); }
  catch (error) { if (error instanceof NativeGatewayFailure && error.code === 'operation_not_found') return null; throw error; }
}
