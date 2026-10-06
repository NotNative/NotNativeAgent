// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA WebFetch trust family contract (20261005-15).
 * Trust is an authority grant, not a presentation preference: the family models the exact
 * credential-free HTTP(S) origins whose private destinations the operator chose to trust,
 * changed only through trust/revoke operations. There is no secret in this family, so reads
 * project the origin list verbatim; every local candidate computation still mirrors NNA's
 * grammar and normalization exactly.
 * Invariant: only the fields NNA's projector whitelists are accepted, origins canonicalize
 * the same way the store normalizes them, and an absent file reads as sticky defaults
 * (source_state 'absent' with revision 'absent'), exactly like the webfetch CLI. */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration/web-fetch';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const PERSISTED_REVISION = /^[a-f0-9]{64}$/u;
// NNA caps stored origins at 300 canonical characters (the longest legal DNS host is
// 253 bytes plus scheme and port), so 64 entries x ~303 JSON bytes stays inside the
// 24,576-byte response bound. Mirror the cap, not just the count.
export const WEB_FETCH_ORIGIN_LIMIT = 300;
// NNA writes updated_at with the canonical toISOString() shape (the domain rejects anything else).
const UPDATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REQUEST_BOUNDS = 4096;
const RESPONSE_BOUNDS = 24576;
const ORIGINS_LIMIT = 64;
const RECORD = /^[a-z][a-z0-9_]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new NativeWebFetchFailure('nnd_web_fetch_view_invalid');
const requestInvalid = () => new NativeWebFetchFailure('nnd_web_fetch_request_invalid');
export class NativeWebFetchFailure extends Error { constructor(readonly code: string) { super(code); } }

/** Mirror of NNA's normalizeTrustedOrigin: an exact credential-free HTTP(S) origin. */
export function isValidWebFetchOriginDraft(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['', '/'].includes(url.pathname) && !url.search && !url.hash
      && url.origin.length <= WEB_FETCH_ORIGIN_LIMIT;
  } catch { return false; }
}
function canonicalOrigin(value: unknown): string {
  if (!isValidWebFetchOriginDraft(value)) throw requestInvalid();
  return new URL(value).origin;
}
const canonicalOrigins = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length <= ORIGINS_LIMIT
  && (() => { try { const list = value.map(item => canonicalOrigin(item));
    return list.length === new Set(list).size && list.join('|') === [...new Set(list)].sort().join('|'); }
    catch { return false; } })();

export interface NativeWebFetchView { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'present' | 'absent'; source_revision: string; resolution_revision: string; project_shadowed: false;
  version: number; trusted_origins: readonly string[]; updated_at: string | null; application: 'next_fetch' }
export type NativeWebFetchCatalogField = { path: 'trusted_origins'; classification: 'authority_grant'; type: 'array';
  application: 'next_fetch'; editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } }
  | { path: 'version' | 'updated_at'; classification: 'generated_state';
    application: 'next_fetch'; editability: { available: false; scope: 'user'; reason: 'generated_state' } };
export interface NativeWebFetchCatalog { schema_version: '1.0'; source: 'web_fetch'; scope: 'user';
  fields: readonly NativeWebFetchCatalogField[] }
export type NativeWebFetchOperation = { op: 'trust' | 'revoke'; origin: string };
export interface NativeWebFetchRequest { installation_id: string; data_id: string; scope: 'user';
  expected_revision: string; expected_resolution_revision: string; operations: readonly NativeWebFetchOperation[] }
export interface NativeWebFetchReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; before_revision: string; persisted_revision: string | null;
  application: 'next_fetch'; next_action: 'next_fetch' | 'inspect_native_operation'; replayed: boolean;
  replay_window: 'last_128_operations' }

export function parseNativeWebFetchView(raw: unknown): NativeWebFetchView {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id) || raw.scope !== 'user'
    || !(raw.source_state === 'present' || raw.source_state === 'absent')
    || typeof raw.source_revision !== 'string' || !REVISION.test(raw.source_revision)
    || raw.resolution_revision !== raw.source_revision || raw.project_shadowed !== false
    || raw.version !== 1 || !canonicalOrigins(raw.trusted_origins)
    || !Array.isArray(raw.trusted_origins)
    || raw.trusted_origins.some(item => typeof item !== 'string')
    || !(raw.updated_at === null || typeof raw.updated_at === 'string' && UPDATED_AT.test(raw.updated_at))
    // Sticky-defaults honesty only applies to the un-stamped absent read: a bootstrap
    // preview carries its proposed stamp and a non-empty origin list by design.
    || (raw.source_state === 'absent' && (raw.source_revision !== 'absent'
      || (raw.updated_at === null && (raw.trusted_origins as string[]).length > 0)))
    || raw.application !== 'next_fetch') throw invalid();
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id, scope: 'user',
    source_state: raw.source_state as NativeWebFetchView['source_state'], source_revision: raw.source_revision,
    resolution_revision: raw.resolution_revision, project_shadowed: false, version: raw.version as number,
    trusted_origins: Object.freeze([...raw.trusted_origins as string[]]),
    updated_at: raw.updated_at as string | null, application: 'next_fetch' };
}

const CATALOG_PATHS = ['trusted_origins', 'version', 'updated_at'] as const;
function parseCatalog(raw: unknown): NativeWebFetchCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'web_fetch' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== 3) throw invalid();
  const fields: NativeWebFetchCatalogField[] = raw.fields.map(entry => {
    if (!record(entry) || !CATALOG_PATHS.includes(entry.path as typeof CATALOG_PATHS[number])
      || entry.application !== 'next_fetch' || !record(entry.editability)) throw invalid();
    if (entry.path === 'trusted_origins') {
      if (entry.classification !== 'authority_grant' || entry.type !== 'array') throw invalid();
      const editability = entry.editability as Record<string, unknown>;
      if (editability.available !== true || editability.scope !== 'user'
        || editability.required_permission !== 'nnd.configuration.manage') throw invalid();
      return { path: 'trusted_origins', classification: 'authority_grant' as const, type: 'array' as const,
        application: 'next_fetch', editability: { available: true as const, scope: 'user',
          required_permission: 'nnd.configuration.manage' } };
    }
    if (entry.classification !== 'generated_state' || entry.editability.available !== false
      || entry.editability.reason !== 'generated_state' || entry.editability.scope !== 'user') throw invalid();
    return { path: entry.path as 'version' | 'updated_at', classification: 'generated_state' as const,
      application: 'next_fetch',
      editability: { available: false as const, scope: 'user', reason: 'generated_state' as const } };
  });
  const seen = new Set(fields.map(field => field.path));
  if (seen.size !== 3) throw invalid();
  return { schema_version: '1.0', source: 'web_fetch', scope: 'user', fields };
}

function validateOperation(operation: unknown): NativeWebFetchOperation {
  if (!record(operation) || !(operation.op === 'trust' || operation.op === 'revoke')) throw requestInvalid();
  if (Object.keys(operation).sort().join(',') !== 'op,origin') throw requestInvalid();
  return { op: operation.op, origin: canonicalOrigin(operation.origin) };
}

/** Compose one bounded native change batch. Origins canonize here, before transport, so the
 * request matches what the store will normalize and preview equality stays exact. */
export function nativeWebFetchOperations(operations: readonly unknown[]): readonly NativeWebFetchOperation[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16) throw requestInvalid();
  return Object.freeze(operations.map(validateOperation)) as readonly NativeWebFetchOperation[];
}

export function nativeWebFetchRequest(view: NativeWebFetchView, operations: readonly NativeWebFetchOperation[],
  ): NativeWebFetchRequest {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16
    || view.project_shadowed) throw requestInvalid();
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision,
    operations: Object.freeze([...operations]) as readonly NativeWebFetchOperation[] };
}

/** Local mirror of NNA's family transaction. Trust adds a canonical origin once; revoke
 * removes it; the candidate is deduped and lexicographically sorted exactly as the store
 * normalizes the published file. */
export function projectNativeWebFetchOperations(view: NativeWebFetchView,
  operations: readonly NativeWebFetchOperation[]): NativeWebFetchView {
  const origins = [...view.trusted_origins];
  for (const operation of operations) {
    if (operation.op === 'trust') origins.push(operation.origin);
    else {
      const at = origins.indexOf(operation.origin); if (at >= 0) origins.splice(at, 1);
    }
  }
  const normalized = [...new Set(origins)].sort();
  return { ...view, trusted_origins: Object.freeze(normalized) };
}

function parseReceipt(raw: unknown, identity: { installation_id: string; data_id: string }, operationId: string,
  expectedRevision?: string): NativeWebFetchReceipt {
  if (!record(raw) || raw.installation_id !== identity.installation_id || raw.data_id !== identity.data_id
    || raw.scope !== 'user' || raw.operation_id !== operationId
    || !['saved', 'unpublished', 'unknown'].includes(String(raw.persistence))
    || typeof raw.before_revision !== 'string' || !REVISION.test(raw.before_revision)
    || expectedRevision !== undefined && raw.before_revision !== expectedRevision
    || !(raw.persisted_revision === null || typeof raw.persisted_revision === 'string' && PERSISTED_REVISION.test(raw.persisted_revision))
    || raw.persistence === 'saved' && raw.persisted_revision === null || raw.application !== 'next_fetch'
    || raw.next_action !== (raw.persistence === 'saved' ? 'next_fetch' : 'inspect_native_operation')
    || typeof raw.replayed !== 'boolean' || raw.replay_window !== 'last_128_operations') throw invalid();
  return { installation_id: raw.installation_id as string, data_id: raw.data_id as string, scope: 'user',
    operation_id: operationId, persistence: raw.persistence as NativeWebFetchReceipt['persistence'],
    before_revision: raw.before_revision as string, persisted_revision: raw.persisted_revision as string | null,
    application: 'next_fetch', next_action: raw.next_action as NativeWebFetchReceipt['next_action'],
    replayed: raw.replayed as boolean, replay_window: 'last_128_operations' };
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader(); if (!reader) throw invalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break;
    size += item.value.byteLength; if (size > bounds) { await reader.cancel(); throw invalid(); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
}

async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > REQUEST_BOUNDS) {
    throw new NativeWebFetchFailure('nnd_web_fetch_request_invalid');
  }
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response, RESPONSE_BOUNDS);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && RECORD.test(error.code) ? error.code
      : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
        : response.status === 404 ? 'nnd_web_fetch_unsupported' : 'nnd_web_fetch_unavailable';
    throw new NativeWebFetchFailure(code);
  }
  return payload;
}

export async function readNativeWebFetch(signal: AbortSignal): Promise<NativeWebFetchView> {
  return parseNativeWebFetchView(await call('', 'GET', signal));
}
export async function readNativeWebFetchCatalog(signal: AbortSignal): Promise<NativeWebFetchCatalog> {
  return parseCatalog(await call('/catalog', 'GET', signal));
}
export async function previewNativeWebFetch(request: NativeWebFetchRequest, current: NativeWebFetchView,
  signal: AbortSignal): Promise<NativeWebFetchView> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'next_fetch'
    || raw.expected_revision !== request.expected_revision || raw.resolution_revision !== request.expected_resolution_revision) throw invalid();
  const view = parseNativeWebFetchView(raw.view);
  if (view.installation_id !== request.installation_id || view.data_id !== request.data_id
    || view.source_revision !== request.expected_revision) throw invalid();
  // updated_at is stamped by the server save; a preview may carry a provisional stamp, so
  // it is shape-validated but not compared.
  const expected = projectNativeWebFetchOperations(current, request.operations);
  const same = ['schema_version', 'source_state', 'source_revision', 'resolution_revision', 'version']
    .every(key => JSON.stringify(view[key as keyof NativeWebFetchView]) === JSON.stringify(expected[key as keyof NativeWebFetchView]))
    && view.trusted_origins.join(',') === expected.trusted_origins.join(',');
  if (!same) throw invalid();
  return view;
}
export async function saveNativeWebFetch(request: NativeWebFetchRequest, operationId: string,
  signal: AbortSignal): Promise<NativeWebFetchReceipt> {
  if (authorityState() !== 'ready' || !OPERATION_ID.test(operationId)) throw new NativeWebFetchFailure('nnd_web_fetch_unavailable');
  return parseReceipt(await call('/save', 'POST', signal, { ...request, operation_id: operationId }), request,
    operationId, request.expected_revision);
}
export async function inspectNativeWebFetchOperation(identity: { installation_id: string; data_id: string },
  operationId: string, signal: AbortSignal): Promise<NativeWebFetchReceipt | null> {
  if (!OPERATION_ID.test(operationId)) throw new NativeWebFetchFailure('nnd_web_fetch_request_invalid');
  try { return parseReceipt(await call(`/operations/${operationId}`, 'GET', signal), identity, operationId); }
  catch (error) { if (error instanceof NativeWebFetchFailure && error.code === 'operation_not_found') return null; throw error; }
}
