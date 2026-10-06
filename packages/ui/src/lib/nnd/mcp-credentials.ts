// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA managed-MCP-credential family contract (20261006-7).
 * The family covers config/mcp-credentials.json, the store the engine host applies to
 * MCP server environments as NNA_MCP_MANAGED_…_TOKEN references. Reads carry references
 * and an `applied` presence flag only, so token VALUES never project; save derives the
 * reference from a server id (idempotent upsert) and delete is an idempotent receipt
 * ('deleted' | 'absent'). There is no operations ledger: receipts claim nothing about
 * replay, and application classifies as 'next_server_spawn'. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/mcp-credentials';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const REFERENCE = /^NNA_MCP_MANAGED_[A-Z0-9_]+_[0-9A-F]{12}_TOKEN$/u;
// The domain's server-id grammar: printable characters without controls, because the
// reference derives an uppercase stem from the raw value.
const SERVER = /^[!"#$%&'()*+,\-./0-9:;<=>?@A-Z[\\\]^_`a-z{|}~]{1,128}$/u;
// NNA binds this family's request to 24,576 bytes (a legal token is up to 16,384
// characters of the domain's MAX_TOKEN_LENGTH) and its JSON to 65,536; the client keeps
// the same request cap and pins the response bound.
export const MCP_CREDENTIALS_REQUEST_BOUNDS = 24_576;
export const MCP_CREDENTIALS_RESPONSE_BOUNDS = 65_536;

export class NativeMcpCredentialsFailure extends Error { constructor(readonly code: string) { super(code); } }
const viewInvalid = () => new NativeMcpCredentialsFailure('nnd_mcp_credentials_view_invalid');
const requestInvalid = () => new NativeMcpCredentialsFailure('nnd_mcp_credentials_request_invalid');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface CredentialEntry { reference: string; applied: boolean }
export interface NativeMcpCredentialList extends Record<string, unknown> {
  installation_id: string; data_id: string; scope: 'user'; source_state: 'present' | 'absent';
  count: number; credentials: readonly CredentialEntry[]; application: 'next_server_spawn'; }
export interface NativeMcpCredentialReceipt {
  installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'deleted' | 'absent'; reference: string; application: 'next_server_spawn';
  next_action: 'inspect_native_operation'; }
export interface NativeMcpCredentialCatalog {
  schema_version: '1.0'; source: 'managed_mcp_credentials'; scope: 'user';
  fields: readonly [{ path: 'credentials.{NNA_MCP_MANAGED_reference}'; classification: 'operator_setting';
    type: 'secret'; application: 'next_server_spawn'; scope: 'user';
    required_permission: 'nnd.configuration.manage';
    editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } }]; }
export interface NativeMcpCredentialRequest { installation_id: string; data_id: string; scope: 'user';
  server_id?: string; token?: string; reference?: string; operation_id: string; }

export function isValidManagedServerIdDraft(value: unknown): boolean {
  return typeof value === 'string' && SERVER.test(value) && value.trim().length > 0;
}
export function isValidManagedTokenDraft(value: unknown): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 16_384 && !/[\r\n\u0000]/u.test(value);
}
export function isManagedMcpReferenceDraft(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 128 && REFERENCE.test(value);
}

export function parseNativeMcpCredentialList(raw: unknown): NativeMcpCredentialList {
  if (!record(raw) || Object.keys(raw).sort().join(',') !== 'application,count,credentials,data_id,'
    + 'installation_id,scope,source_state'
    || raw.application !== 'next_server_spawn' || raw.scope !== 'user'
    || raw.source_state !== 'present' && raw.source_state !== 'absent'
    || !Array.isArray(raw.credentials) || !Number.isSafeInteger(raw.count)) throw viewInvalid();
  const credentials = raw.credentials.map((entry): CredentialEntry => {
    if (!record(entry) || Object.keys(entry).sort().join(',') !== 'applied,reference'
      || !isManagedMcpReferenceDraft(entry.reference) || typeof entry.applied !== 'boolean') throw viewInvalid();
    return { reference: entry.reference as string, applied: entry.applied as boolean };
  });
  if (raw.count !== credentials.length
    || raw.source_state === 'absent' && credentials.length !== 0) throw viewInvalid();
  return { installation_id: raw.installation_id as string, data_id: raw.data_id as string, scope: 'user',
    source_state: raw.source_state as NativeMcpCredentialList['source_state'], count: credentials.length,
    credentials, application: 'next_server_spawn' };
}

export function parseNativeMcpCredentialCatalog(raw: unknown): NativeMcpCredentialCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'managed_mcp_credentials'
    || raw.scope !== 'user' || !Array.isArray(raw.fields) || raw.fields.length !== 1) throw viewInvalid();
  const field = raw.fields[0];
  if (!record(field) || field.path !== 'credentials.{NNA_MCP_MANAGED_reference}'
    || field.classification !== 'operator_setting' || field.type !== 'secret'
    || field.application !== 'next_server_spawn' || field.scope !== 'user'
    || field.required_permission !== 'nnd.configuration.manage' || !record(field.editability)
    || field.editability.available !== true || field.editability.scope !== 'user'
    || field.editability.required_permission !== 'nnd.configuration.manage') throw viewInvalid();
  return { schema_version: '1.0', source: 'managed_mcp_credentials', scope: 'user',
    fields: [field] as unknown as NativeMcpCredentialCatalog['fields'] };
}

function parseNativeMcpCredentialReceipt(raw: unknown, operationId: string): NativeMcpCredentialReceipt {
  if (!record(raw) || Object.keys(raw).sort().join(',') !== 'application,data_id,installation_id,'
    + 'next_action,operation_id,persistence,reference,scope'
    || raw.operation_id !== operationId || raw.persistence !== 'saved' && raw.persistence !== 'deleted'
    && raw.persistence !== 'absent' || raw.application !== 'next_server_spawn'
    || raw.next_action !== 'inspect_native_operation' || !isManagedMcpReferenceDraft(raw.reference)) {
    throw viewInvalid();
  }
  return { installation_id: raw.installation_id as string, data_id: raw.data_id as string, scope: 'user',
    operation_id: operationId, persistence: raw.persistence as NativeMcpCredentialReceipt['persistence'],
    reference: raw.reference as string, application: 'next_server_spawn',
    next_action: 'inspect_native_operation' };
}

async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > MCP_CREDENTIALS_REQUEST_BOUNDS) {
    throw requestInvalid();
  }
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response, MCP_CREDENTIALS_RESPONSE_BOUNDS);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = typeof error?.code === 'string' ? error.code
      : response.status === 404 ? 'nnd_mcp_credentials_unsupported' : 'nnd_mcp_credentials_unavailable';
    throw new NativeMcpCredentialsFailure(code);
  }
  return payload;
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw viewInvalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > bounds) { await reader.cancel(); throw viewInvalid(); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw viewInvalid(); }
}

export async function readNativeMcpCredentialList(signal: AbortSignal): Promise<NativeMcpCredentialList> {
  return parseNativeMcpCredentialList(await call('', 'GET', signal));
}
export async function readNativeMcpCredentialCatalog(signal: AbortSignal): Promise<NativeMcpCredentialCatalog> {
  return parseNativeMcpCredentialCatalog(await call('/catalog', 'GET', signal));
}

/** Composers pin the request surface: identity from the current list, the operation id
 * required, and a token that stays inside one bounded POST. They are pure so the lib
 * tests cover the wire shape exactly; save/delete then post + pin the receipt. */
export function nativeMcpCredentialSaveRequest(list: NativeMcpCredentialList, binding: {
  server_id: string; token: string; operation_id: string }): NativeMcpCredentialRequest {
  if (!list || typeof list !== 'object' || !ID.test(list.installation_id) || !ID.test(list.data_id)) {
    throw viewInvalid();
  }
  if (!OPERATION_ID.test(binding.operation_id)) throw requestInvalid();
  if (!isValidManagedServerIdDraft(binding.server_id)) throw requestInvalid();
  if (!isValidManagedTokenDraft(binding.token)) {
    throw new NativeMcpCredentialsFailure('mcp_token_invalid');
  }
  return { installation_id: list.installation_id, data_id: list.data_id, scope: list.scope,
    server_id: binding.server_id, token: binding.token, operation_id: binding.operation_id };
}

export function nativeMcpCredentialDeleteRequest(list: NativeMcpCredentialList, binding: {
  reference: string; operation_id: string }): NativeMcpCredentialRequest {
  if (!list || typeof list !== 'object' || !ID.test(list.installation_id) || !ID.test(list.data_id)) {
    throw viewInvalid();
  }
  if (!OPERATION_ID.test(binding.operation_id)) throw requestInvalid();
  if (!isManagedMcpReferenceDraft(binding.reference)) throw requestInvalid();
  return { installation_id: list.installation_id, data_id: list.data_id, scope: list.scope,
    reference: binding.reference, operation_id: binding.operation_id };
}

export async function saveNativeMcpCredential(composed: { list: NativeMcpCredentialList; server_id: string;
  token: string; operation_id: string }, signal: AbortSignal): Promise<NativeMcpCredentialReceipt> {
  const request = nativeMcpCredentialSaveRequest(composed.list, composed);
  return parseNativeMcpCredentialReceipt(await call('/credentials/save', 'POST', signal, request),
    request.operation_id);
}

export async function deleteNativeMcpCredential(composed: { list: NativeMcpCredentialList; reference: string;
  operation_id: string }, signal: AbortSignal): Promise<NativeMcpCredentialReceipt> {
  const request = nativeMcpCredentialDeleteRequest(composed.list, composed);
  return parseNativeMcpCredentialReceipt(await call('/credentials/delete', 'POST', signal, request),
    request.operation_id);
}
