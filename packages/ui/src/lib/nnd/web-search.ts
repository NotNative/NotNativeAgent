// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA WebSearch settings family contract (20261006-1).
 * The family models the enabled flag plus at most eight canonical SearXNG profiles in
 * config/web-search.json, changed only through set_enabled/add_profile/promote_profile/
 * remove_profile. There is no secret in this family (the endpoint is transport config,
 * not a credential), so reads project the profile list in order (primary first); every
 * local candidate computation still mirrors NNA's grammar and normalization exactly.
 * Invariant: only the fields NNA's projector whitelists are accepted, endpoints and
 * profile names canonicalize the same way the domain normalizes them, and an absent
 * file reads as sticky defaults (source_state 'absent' with revision 'absent'), exactly
 * like the websearch CLI. Unlike the WebFetch family there is no updated_at stamp: an
 * absent basis carries only defaults on a read, and any richer content with revision
 * 'absent' can only be a bootstrap preview (the server never returns it on a read). */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration/web-search';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const PERSISTED_REVISION = /^[a-f0-9]{64}$/u;
// NNA accepts the stored file up to 65,536 bytes and a legal add_profile endpoint can
// approach that bound before the transform's file-size validation refuses, so the
// native envelope doubles both transport bounds.
export const WEB_SEARCH_REQUEST_BOUNDS = 131072;
export const WEB_SEARCH_RESPONSE_BOUNDS = 131072;
export const WEB_SEARCH_PROFILE_LIMIT = 8;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const RECORD = /^[a-z][a-z0-9_]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new NativeWebSearchFailure('nnd_web_search_view_invalid');
const requestInvalid = () => new NativeWebSearchFailure('nnd_web_search_request_invalid');
export class NativeWebSearchFailure extends Error { constructor(readonly code: string) { super(code); } }

/** Canonical endpoint text exactly like NNA's normalizeSearxngEndpoint: a credential-free
 * HTTP(S) base URL whose trailing /search or slash collapses to the bare base. */
export function canonicalWebSearchEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new NativeWebSearchFailure('web_search_endpoint_invalid');
  let url: URL;
  try { url = new URL(value); } catch { throw new NativeWebSearchFailure('web_search_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new NativeWebSearchFailure('web_search_endpoint_invalid');
  }
  url.pathname = url.pathname.replace(/\/(?:search)?\/?$/u, '') || '/';
  return url.href.replace(/\/$/u, '');
}
export function isValidWebSearchEndpointDraft(value: unknown): value is string {
  try { canonicalWebSearchEndpoint(value); return true; } catch { return false; }
}
export function isValidWebSearchNameDraft(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && Array.from(trimmed).length <= 128;
}
function canonicalName(value: unknown): string {
  if (!isValidWebSearchNameDraft(value)) throw new NativeWebSearchFailure('web_search_profile_name_invalid');
  return value.trim();
}
function profileId(value: unknown): string {
  if (typeof value !== 'string' || !PROFILE_ID.test(value)) {
    throw new NativeWebSearchFailure('web_search_profile_id_invalid');
  }
  return value;
}
function parseProfile(value: unknown): WebSearchProfile {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'display_name,endpoint,id,managed,provider'
    || value.provider !== 'searxng' || typeof value.display_name !== 'string'
    || !isValidWebSearchNameDraft(value.display_name)
    || (value.managed !== true && value.managed !== false)
    || !isValidWebSearchEndpointDraft(value.endpoint) || typeof value.id !== 'string' || !PROFILE_ID.test(value.id)) {
    throw invalid();
  }
  return { id: value.id, display_name: value.display_name.trim(), provider: 'searxng',
    endpoint: canonicalWebSearchEndpoint(value.endpoint), managed: value.managed === true };
}
interface WebSearchProfile { id: string; display_name: string; provider: 'searxng'; endpoint: string; managed: boolean }
const parseProfiles = (value: unknown): readonly WebSearchProfile[] => {
  if (!Array.isArray(value) || value.length > WEB_SEARCH_PROFILE_LIMIT) throw invalid();
  const profiles = value.map(parseProfile);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length
    || new Set(profiles.map(profile => profile.endpoint)).size !== profiles.length) throw invalid();
  return profiles;
};

export interface NativeWebSearchView { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'present' | 'absent'; source_revision: string; resolution_revision: string; project_shadowed: false;
  version: number; enabled: boolean; profiles: readonly WebSearchProfile[]; application: 'next_search' }
export type NativeWebSearchCatalogField = { path: 'enabled'; classification: 'operator_setting'; type?: undefined;
  application: 'next_search'; editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } }
  | { path: 'profiles'; classification: 'operator_setting'; type: 'array'; application: 'next_search';
    operations: readonly ['add_profile', 'promote_profile', 'remove_profile'];
    editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } }
  | { path: 'version'; classification: 'generated_state';
    application: 'next_search'; editability: { available: false; scope: 'user'; reason: 'generated_state' } };
export interface NativeWebSearchCatalog { schema_version: '1.0'; source: 'web_search'; scope: 'user';
  fields: readonly NativeWebSearchCatalogField[] }
export type NativeWebSearchOperation =
  | { op: 'set_enabled'; enabled: boolean }
  | { op: 'add_profile'; display_name: string; endpoint: string }
  | { op: 'promote_profile'; id: string }
  | { op: 'remove_profile'; id: string };
export interface NativeWebSearchRequest { installation_id: string; data_id: string; scope: 'user';
  expected_revision: string; expected_resolution_revision: string; operations: readonly NativeWebSearchOperation[] }
export interface NativeWebSearchReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; before_revision: string; persisted_revision: string | null;
  application: 'next_search'; next_action: 'next_search' | 'inspect_native_operation'; replayed: boolean;
  replay_window: 'last_128_operations' }

export function parseNativeWebSearchView(raw: unknown): NativeWebSearchView {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id) || raw.scope !== 'user'
    || !(raw.source_state === 'present' || raw.source_state === 'absent')
    || typeof raw.source_revision !== 'string' || !REVISION.test(raw.source_revision)
    || raw.resolution_revision !== raw.source_revision || raw.project_shadowed !== false
    || raw.version !== 2 || typeof raw.enabled !== 'boolean' || raw.application !== 'next_search') throw invalid();
  const profiles = parseProfiles(raw.profiles);
  // The absent basis exists only under the absent revision; a present-shaped revision
  // under an absent state is projector drift. (There is no updated_at stamp in this
  // family, so a richer absent view can only be a bootstrap preview.)
  if (raw.source_state === 'absent' && raw.source_revision !== 'absent') throw invalid();
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id, scope: 'user',
    source_state: raw.source_state as NativeWebSearchView['source_state'], source_revision: raw.source_revision,
    resolution_revision: raw.resolution_revision, project_shadowed: false, version: 2,
    enabled: raw.enabled as boolean,
    profiles: Object.freeze(profiles.map(profile => ({ ...profile }))) as readonly WebSearchProfile[],
    application: 'next_search' };
}

const CATALOG_PATHS = ['enabled', 'profiles', 'version'] as const;
function parseCatalog(raw: unknown): NativeWebSearchCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'web_search' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== 3) throw invalid();
  const fields: NativeWebSearchCatalogField[] = raw.fields.map(entry => {
    if (!record(entry) || !CATALOG_PATHS.includes(entry.path as typeof CATALOG_PATHS[number])
      || entry.application !== 'next_search' || !record(entry.editability)) throw invalid();
    const editable = entry.editability.available === true && entry.editability.scope === 'user'
      && entry.editability.required_permission === 'nnd.configuration.manage';
    if (entry.path === 'enabled') {
      if (entry.classification !== 'operator_setting' || !editable) throw invalid();
      return { path: 'enabled', classification: 'operator_setting' as const, application: 'next_search',
        editability: { available: true as const, scope: 'user', required_permission: 'nnd.configuration.manage' } };
    }
    if (entry.path === 'profiles') {
      if (entry.classification !== 'operator_setting' || entry.type !== 'array' || !editable) throw invalid();
      return { path: 'profiles', classification: 'operator_setting' as const, type: 'array' as const,
        application: 'next_search',
        operations: ['add_profile', 'promote_profile', 'remove_profile'] as const,
        editability: { available: true as const, scope: 'user', required_permission: 'nnd.configuration.manage' } };
    }
    if (entry.classification !== 'generated_state' || entry.editability.available !== false
      || entry.editability.reason !== 'generated_state' || entry.editability.scope !== 'user') throw invalid();
    return { path: 'version', classification: 'generated_state' as const, application: 'next_search',
      editability: { available: false as const, scope: 'user', reason: 'generated_state' as const } };
  });
  const seen = new Set(fields.map(field => field.path));
  if (seen.size !== 3) throw invalid();
  return { schema_version: '1.0', source: 'web_search', scope: 'user', fields };
}

function validateOperation(operation: unknown): NativeWebSearchOperation {
  const shapes: Record<NativeWebSearchOperation['op'], string> = {
    set_enabled: 'enabled,op', add_profile: 'display_name,endpoint,op',
    promote_profile: 'id,op', remove_profile: 'id,op',
  };
  if (!record(operation)) throw requestInvalid();
  const keys = Object.keys(operation).sort().join(',');
  if (operation.op === 'set_enabled' && keys === shapes.set_enabled) {
    if (operation.enabled !== true && operation.enabled !== false) throw requestInvalid();
    return { op: 'set_enabled', enabled: operation.enabled as boolean };
  }
  if (operation.op === 'add_profile' && keys === shapes.add_profile) {
    return { op: 'add_profile', display_name: canonicalName(operation.display_name),
      endpoint: canonicalWebSearchEndpoint(operation.endpoint) };
  }
  if ((operation.op === 'promote_profile' || operation.op === 'remove_profile') && keys === shapes[operation.op]) {
    return { op: operation.op, id: profileId(operation.id) };
  }
  throw requestInvalid();
}

/** Compose one bounded native change batch. Endpoints and names canonize here, before
 * transport, so the request matches what the domain will normalize. Domain refusals
 * (duplicate endpoint, missing profile, bad grammar) keep their governed codes, matching
 * the native transaction's forwarding policy. */
export function nativeWebSearchOperations(operations: readonly unknown[]): readonly NativeWebSearchOperation[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16) throw requestInvalid();
  return Object.freeze(operations.map(validateOperation)) as readonly NativeWebSearchOperation[];
}

export function nativeWebSearchRequest(view: NativeWebSearchView, operations: readonly NativeWebSearchOperation[],
  ): NativeWebSearchRequest {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16
    || view.project_shadowed) throw requestInvalid();
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision,
    operations: Object.freeze([...operations]) as readonly NativeWebSearchOperation[] };
}

/** Mirror of NNA's availableProfileId: derive a unique slug id from the display name. */
function availableId(displayName: string, existingIds: readonly string[]): string {
  const stem = displayName.normalize('NFKD').replaceAll(/\p{Mark}/gu, '').toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 56) || 'search';
  const existing = new Set(existingIds);
  if (!existing.has(stem)) return stem;
  for (let index = 2; index <= 9999; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${stem.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new NativeWebSearchFailure('web_search_profile_id_exhausted');
}

/** Local mirror of NNA's family transaction, applied in order. An add appends with the
 * domain slug id and — by domain parity — leaves the enabled decision to the caller
 * (the op can be composed back-to-back); promote moves a profile to primary; remove
 * deletes one and honestly disables when the last profile leaves. */
export function projectNativeWebSearchOperations(view: NativeWebSearchView,
  operations: readonly NativeWebSearchOperation[]): NativeWebSearchView {
  let enabled = view.enabled;
  let profiles = [...view.profiles].map(profile => ({ ...profile }));
  for (const operation of operations) {
    if (operation.op === 'set_enabled') {
      // Domain parity: enabling a configuration without profiles is refused with the
      // domain's endpoint-required code (the server refuses the same way, so a preview
      // of that composition never returns a view to compare against).
      if (operation.enabled && profiles.length === 0) {
        throw new NativeWebSearchFailure('web_search_endpoint_required');
      }
      enabled = operation.enabled;
    } else if (operation.op === 'add_profile') {
      if (profiles.length >= WEB_SEARCH_PROFILE_LIMIT) throw new NativeWebSearchFailure('web_search_profiles_too_many');
      const endpoint = operation.endpoint;
      if (profiles.some(profile => profile.endpoint === endpoint)) {
        throw new NativeWebSearchFailure('web_search_endpoint_duplicate');
      }
      const id = availableId(operation.display_name, profiles.map(profile => profile.id));
      profiles = [...profiles, { id, display_name: operation.display_name, provider: 'searxng',
        endpoint, managed: false }];
      enabled = true;
    } else if (operation.op === 'promote_profile') {
      const at = profiles.findIndex(profile => profile.id === operation.id);
      if (at < 0) throw new NativeWebSearchFailure('web_search_profile_missing');
      if (at > 0) {
        const [selected] = profiles.splice(at, 1);
        if (selected === undefined) throw new NativeWebSearchFailure('web_search_profile_missing');
        profiles = [selected, ...profiles];
      }
    } else {
      if (!profiles.some(profile => profile.id === operation.id)) throw new NativeWebSearchFailure('web_search_profile_missing');
      profiles = profiles.filter(profile => profile.id !== operation.id);
      if (profiles.length === 0) enabled = false;
    }
  }
  return { ...view, enabled, profiles: Object.freeze(profiles) as readonly WebSearchProfile[] };
}

function parseReceipt(raw: unknown, identity: { installation_id: string; data_id: string }, operationId: string,
  expectedRevision?: string): NativeWebSearchReceipt {
  if (!record(raw) || raw.installation_id !== identity.installation_id || raw.data_id !== identity.data_id
    || raw.scope !== 'user' || raw.operation_id !== operationId
    || !['saved', 'unpublished', 'unknown'].includes(String(raw.persistence))
    || typeof raw.before_revision !== 'string' || !REVISION.test(raw.before_revision)
    || expectedRevision !== undefined && raw.before_revision !== expectedRevision
    || !(raw.persisted_revision === null || typeof raw.persisted_revision === 'string' && PERSISTED_REVISION.test(raw.persisted_revision))
    || raw.persistence === 'saved' && raw.persisted_revision === null || raw.application !== 'next_search'
    || raw.next_action !== (raw.persistence === 'saved' ? 'next_search' : 'inspect_native_operation')
    || typeof raw.replayed !== 'boolean' || raw.replay_window !== 'last_128_operations') throw invalid();
  return { installation_id: raw.installation_id as string, data_id: raw.data_id as string, scope: 'user',
    operation_id: operationId, persistence: raw.persistence as NativeWebSearchReceipt['persistence'],
    before_revision: raw.before_revision as string, persisted_revision: raw.persisted_revision as string | null,
    application: 'next_search', next_action: raw.next_action as NativeWebSearchReceipt['next_action'],
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
  if (encoded && new TextEncoder().encode(encoded).byteLength > WEB_SEARCH_REQUEST_BOUNDS) {
    throw new NativeWebSearchFailure('nnd_web_search_request_invalid');
  }
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response, WEB_SEARCH_RESPONSE_BOUNDS);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && RECORD.test(error.code) ? error.code
      : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
        : response.status === 404 ? 'nnd_web_search_unsupported' : 'nnd_web_search_unavailable';
    throw new NativeWebSearchFailure(code);
  }
  return payload;
}

export async function readNativeWebSearch(signal: AbortSignal): Promise<NativeWebSearchView> {
  return parseNativeWebSearchView(await call('', 'GET', signal));
}
export async function readNativeWebSearchCatalog(signal: AbortSignal): Promise<NativeWebSearchCatalog> {
  return parseCatalog(await call('/catalog', 'GET', signal));
}
export async function previewNativeWebSearch(request: NativeWebSearchRequest, current: NativeWebSearchView,
  signal: AbortSignal): Promise<NativeWebSearchView> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'next_search'
    || raw.expected_revision !== request.expected_revision || raw.resolution_revision !== request.expected_resolution_revision) throw invalid();
  const view = parseNativeWebSearchView(raw.view);
  if (view.installation_id !== request.installation_id || view.data_id !== request.data_id
    || view.source_revision !== request.expected_revision) throw invalid();
  const expected = projectNativeWebSearchOperations(current, request.operations);
  const same = view.application === expected.application
    && ['schema_version', 'source_state', 'source_revision', 'resolution_revision', 'version', 'enabled']
      .every(key => JSON.stringify(view[key as keyof NativeWebSearchView]) === JSON.stringify(expected[key as keyof NativeWebSearchView]))
    && JSON.stringify(view.profiles) === JSON.stringify(expected.profiles);
  if (!same) throw invalid();
  return view;
}
export async function saveNativeWebSearch(request: NativeWebSearchRequest, operationId: string,
  signal: AbortSignal): Promise<NativeWebSearchReceipt> {
  if (authorityState() !== 'ready' || !OPERATION_ID.test(operationId)) throw new NativeWebSearchFailure('nnd_web_search_unavailable');
  return parseReceipt(await call('/save', 'POST', signal, { ...request, operation_id: operationId }), request,
    operationId, request.expected_revision);
}
export async function inspectNativeWebSearchOperation(identity: { installation_id: string; data_id: string },
  operationId: string, signal: AbortSignal): Promise<NativeWebSearchReceipt | null> {
  if (!OPERATION_ID.test(operationId)) throw new NativeWebSearchFailure('nnd_web_search_request_invalid');
  try { return parseReceipt(await call(`/operations/${operationId}`, 'GET', signal), identity, operationId); }
  catch (error) { if (error instanceof NativeWebSearchFailure && error.code === 'operation_not_found') return null; throw error; }
}
