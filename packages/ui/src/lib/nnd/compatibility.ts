// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA compatibility-service settings family contract (20261006-6).
 * The family models config/opencode.json — the OpenCode wiring identity (enabled,
 * hostname, port, username) plus the Basic auth secret and the generated
 * version/updated_at pair. The wiring service reads the file at its next start, so
 * every change classifies under application 'next_service_start'.
 * Invariant: secret VALUES never project. Reads carry a presence source only
 * ('restricted local config' or the OPENCODE_SERVER_PASSWORD environment fallback), a
 * candidate's replace value is bound locally but never echoed, and the candidate is a
 * document view (enabled/hostname/port/username) merged server-side over the stored
 * secret via keep/replace/clear. Unknown store keys survive round-trips like every
 * manifest family; an absent file reads as sticky defaults under revision 'absent'. */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration/compatibility-service';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
// An absent file legitimately reads and previews under the absent revision base.
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const PERSISTED_REVISION = /^[a-f0-9]{64}$/u;
// NNA binds the request body to 4,096 bytes and its projector's JSON to 24,576 on the
// wire; the client keeps the same 4,096 request cap and doubles the response bound.
export const COMPATIBILITY_REQUEST_BOUNDS = 4096;
export const COMPATIBILITY_RESPONSE_BOUNDS = 49152;
const RECORD = /^[a-z][a-z0-9_]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new NativeCompatibilityFailure('nnd_compatibility_view_invalid');
const requestInvalid = () => new NativeCompatibilityFailure('nnd_compatibility_request_invalid');
export class NativeCompatibilityFailure extends Error { constructor(readonly code: string) { super(code); } }

/** Local mirrors of NNA's opencode/config.js grammar, so a draft refuses before it
 * ever reaches the wire with exactly the codes the native refusals carry. */
export function isLoopbackClientMirror(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (value === 'localhost' || value === '::1') return true;
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    && Number(parts[0]) === 127;
}
/** Local mirror of NNA's opencode hostname canonicalizer: scheme-less IPv4, IPv6, or
 * DNS. Bound checks run on the raw value exactly like the domain, then the value trims
 * and a single bracket pair around an IPv6 literal unbrackets. */
export function isValidCompatibilityHostnameDraft(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const candidate = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (candidate.includes('[') || candidate.includes(']')) return false;
  return isIPv4Draft(candidate) || isIPv6Draft(candidate) || isDnsHostDraft(candidate);
}
function isIPv4Draft(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}
/** Conservative stand-in for the native net.isIPv6 gate; ambiguous decimals and DNS
 * shapes are excluded and everything hex-colon shaped is accepted here, while the
 * native server remains the one authoritative refusal. */
function isIPv6Draft(value: string): boolean {
  return value.includes(':') && /^[0-9a-f:]+$/iu.test(value)
    && (value.match(/:/gu)?.length ?? 0) >= 2 && !/::.*::/u.test(value)
    && !/^\d+(?:\.\d+)+$/u.test(value);
}
function isDnsHostDraft(value: string): boolean {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/u.test(value)
    && !/^\d+(?:\.\d+)+$/u.test(value);
}
export function isValidCompatibilityUsernameDraft(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    && !/[:\r\n\u0000-\u001f]/u.test(value);
}
export function isValidCompatibilityPasswordDraft(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 512 && !/[\r\n]/u.test(value);
}
export function isValidCompatibilityPortDraft(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

export interface CompatibilityCredentialStatus { configured: boolean; source: 'restricted local config' | 'environment' | null }
export interface NativeCompatibilityView { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'present' | 'absent'; source_revision: string; resolution_revision: string; project_shadowed: false;
  version: 1; enabled: boolean; hostname: string; port: number; username: string;
  password: CompatibilityCredentialStatus; updated_at: string | null; application: 'next_service_start' }

export type NativeCompatibilityCatalogField =
  | { path: 'version' | 'updated_at'; classification: 'generated_state'; application: 'next_service_start';
      editability: { available: false; scope: 'user'; reason: 'generated_state' } }
  | { path: 'enabled' | 'hostname' | 'port' | 'username'; classification: 'operator_setting';
      application: 'next_service_start';
      editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } }
  | { path: 'password'; classification: 'operator_setting'; type: 'secret';
      operations: readonly ['replace_secret', 'clear_secret']; application: 'next_service_start';
      editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } };
export interface NativeCompatibilityCatalog { schema_version: '1.0'; source: 'compatibility_service'; scope: 'user';
  fields: readonly NativeCompatibilityCatalogField[] }
export type CompatibilityPasswordAction = 'keep' | 'replace' | 'clear';
export interface CompatibilityCandidate { enabled: boolean; hostname: string; port: number; username: string;
  password: { action: CompatibilityPasswordAction; replace?: string } }
export interface NativeCompatibilityPreviewRequest { installation_id: string; data_id: string; scope: 'user';
  expected_revision: string; expected_resolution_revision: string;
  view: { enabled: boolean; hostname: string; port: number; username: string };
  password: { action: CompatibilityPasswordAction; value?: string } }
export interface NativeCompatibilityReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; before_revision: string; persisted_revision: string | null;
  application: 'next_service_start'; next_action: 'next_service_start' | 'inspect_native_operation';
  replayed: boolean; replay_window: 'last_128_operations' }

function parseCredential(raw: unknown): CompatibilityCredentialStatus {
  if (!record(raw) || (raw.configured !== true && raw.configured !== false) || 'value' in raw) throw invalid();
  if (raw.source !== null && raw.source !== 'restricted local config' && raw.source !== 'environment') throw invalid();
  if ((raw.configured === true) !== (typeof raw.source === 'string')) throw invalid();
  return { configured: raw.configured as boolean, source: raw.source as CompatibilityCredentialStatus['source'] };
}

function parseUpdatedAt(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) throw invalid();
  return raw;
}

function parseWireIdentity(raw: Record<string, unknown>) {
  if (raw.enabled !== true && raw.enabled !== false || typeof raw.hostname !== 'string'
    || !isValidCompatibilityHostnameDraft(raw.hostname) || !isValidCompatibilityPortDraft(raw.port)
    || raw.hostname !== raw.hostname.trim() || typeof raw.username !== 'string'
    || !isValidCompatibilityUsernameDraft(raw.username) || raw.username !== raw.username.trim()) throw invalid();
  return { enabled: raw.enabled as boolean, hostname: raw.hostname as string, port: raw.port as number,
    username: raw.username as string };
}

// The projector whitelists exactly the family frame plus the seven census keys.
const VIEW_KEYS = 'application,data_id,enabled,hostname,installation_id,password,port,project_shadowed,'
  + 'resolution_revision,schema_version,scope,source_revision,source_state,updated_at,username,version'.split(',')
  .sort().join(',');

export function parseNativeCompatibilityView(raw: unknown): NativeCompatibilityView {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id) || raw.scope !== 'user'
    || !(raw.source_state === 'present' || raw.source_state === 'absent')
    || typeof raw.source_revision !== 'string' || !REVISION.test(raw.source_revision)
    || raw.resolution_revision !== raw.source_revision || raw.project_shadowed !== false
    || raw.version !== 1 || raw.application !== 'next_service_start') throw invalid();
  // The absent basis exists only under the absent revision. Unlike web-search this
  // family stamps updated_at on every native merge, so a richer absent shape is a
  // bootstrap preview: the server never returns a stamped frame on plain reads (the
  // absent read is sticky defaults with updated_at null), which the page tests pin.
  if (raw.source_state === 'absent' && raw.source_revision !== 'absent') throw invalid();
  if (Object.keys(raw).sort().join(',') !== VIEW_KEYS) throw invalid();
  const identity = parseWireIdentity(raw);
  const password = parseCredential(raw.password);
  const updated_at = parseUpdatedAt(raw.updated_at);
  return { schema_version: '1.0', installation_id: raw.installation_id as string, data_id: raw.data_id as string,
    scope: 'user', source_state: raw.source_state as NativeCompatibilityView['source_state'],
    source_revision: raw.source_revision as string, resolution_revision: raw.resolution_revision as string,
    project_shadowed: false, version: 1, ...identity, password,
    updated_at, application: 'next_service_start' };
}

const CATALOG_PATHS = ['enabled', 'hostname', 'password', 'port', 'updated_at', 'username', 'version'] as const;
type CatalogEntry = { path?: unknown; application?: unknown; classification?: unknown; type?: unknown;
  operations?: unknown; editability?: unknown };
type Editability = { available?: unknown; scope?: unknown; reason?: unknown; required_permission?: unknown };
function catalogEditability(entry: CatalogEntry): Editability {
  if (!record(entry.editability)) throw invalid();
  return entry.editability as Editability;
}
export function parseNativeCompatibilityCatalog(raw: unknown): NativeCompatibilityCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'compatibility_service' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== 7) throw invalid();
  const fields = raw.fields.map((entry): NativeCompatibilityCatalogField => {
    if (!record(entry) || !CATALOG_PATHS.includes(entry.path as typeof CATALOG_PATHS[number])
      || entry.application !== 'next_service_start') throw invalid();
    const item = entry as CatalogEntry;
    const editability = catalogEditability(item);
    if (item.path === 'password') {
      // The catalog pins the same statement the route serves: change rights on the wire
      // identity and the secret come with the nnd.configuration.manage authority right.
      if (item.classification !== 'operator_setting' || item.type !== 'secret'
        || !Array.isArray(item.operations)
        || item.operations.join(',') !== 'replace_secret,clear_secret'
        || editability.available !== true || editability.scope !== 'user'
        || editability.required_permission !== 'nnd.configuration.manage') throw invalid();
      return { path: 'password', classification: 'operator_setting', type: 'secret',
        operations: ['replace_secret', 'clear_secret'] as const, application: 'next_service_start',
        editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } };
    }
    if (item.path === 'version' || item.path === 'updated_at') {
      if (item.classification !== 'generated_state' || editability.available !== false
        || editability.reason !== 'generated_state' || editability.scope !== 'user') throw invalid();
      return { path: item.path, classification: 'generated_state', application: 'next_service_start',
        editability: { available: false, scope: 'user', reason: 'generated_state' } };
    }
    if (item.classification !== 'operator_setting' || editability.available !== true
      || editability.scope !== 'user'
      || editability.required_permission !== 'nnd.configuration.manage') throw invalid();
    return { path: item.path as 'enabled' | 'hostname' | 'port' | 'username',
      classification: 'operator_setting', application: 'next_service_start',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } };
  });
  const seen = new Set(fields.map(field => field.path));
  if (seen.size !== 7) throw invalid();
  return { schema_version: '1.0', source: 'compatibility_service', scope: 'user', fields: Object.freeze(fields) };
}

/** Compose the bounded native change request. Hostname, port, username and the replace
 * value canonize here before transport with the domain's own codes, so the request
 * matches what the native integrator will accept. */
export function nativeCompatibilityRequest(view: NativeCompatibilityView, candidate: CompatibilityCandidate,
  ): NativeCompatibilityPreviewRequest {
  if (view.project_shadowed) throw requestInvalid();
  if (typeof candidate.hostname !== 'string' || !isValidCompatibilityHostnameDraft(candidate.hostname)) {
    throw new NativeCompatibilityFailure('opencode_hostname_invalid');
  }
  if (!isValidCompatibilityPortDraft(candidate.port)) throw new NativeCompatibilityFailure('opencode_bind_port_invalid');
  if (!isValidCompatibilityUsernameDraft(candidate.username)) throw new NativeCompatibilityFailure('opencode_username_invalid');
  const action = candidate.password.action;
  if (action === 'keep' && 'replace' in candidate.password) throw requestInvalid();
  if (action === 'replace' && !isValidCompatibilityPasswordDraft(candidate.password.replace)) {
    throw new NativeCompatibilityFailure('opencode_password_invalid');
  }
  if (action === 'clear' && 'replace' in candidate.password) throw requestInvalid();
  const trimHost = candidate.hostname.trim();
  const trimUser = candidate.username.trim();
  const request: NativeCompatibilityPreviewRequest = { installation_id: view.installation_id,
    data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision,
    view: { enabled: candidate.enabled === true, hostname: trimHost, port: candidate.port,
      username: trimUser }, password: action === 'replace'
      ? { action, value: candidate.password.replace } : { action } };
  return request;
}

async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > COMPATIBILITY_REQUEST_BOUNDS) {
    throw requestInvalid();
  }
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response, COMPATIBILITY_RESPONSE_BOUNDS);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && RECORD.test(error.code) ? error.code
      : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
        : response.status === 404 ? 'nnd_compatibility_unsupported' : 'nnd_compatibility_unavailable';
    throw new NativeCompatibilityFailure(code);
  }
  return payload;
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

export async function readNativeCompatibility(signal: AbortSignal): Promise<NativeCompatibilityView> {
  return parseNativeCompatibilityView(await call('', 'GET', signal));
}
export async function readNativeCompatibilityCatalog(signal: AbortSignal): Promise<NativeCompatibilityCatalog> {
  return parseNativeCompatibilityCatalog(await call('/catalog', 'GET', signal));
}

/** Preview assertion parity. The stored secret and any environment override are never
 * projected, so the client asserts the deterministic parts of the merged projection and
 * accepts exactly the credential shapes the native projector can emit for the action:
 * replace pins 'restricted local config', keep keeps the read basis, and clear admits
 * either a fully cleared secret or the environment override surviving it. */
export async function previewNativeCompatibility(request: NativeCompatibilityPreviewRequest,
  current: NativeCompatibilityView, signal: AbortSignal): Promise<NativeCompatibilityView> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'next_service_start'
    || raw.expected_revision !== request.expected_revision
    || raw.resolution_revision !== request.expected_resolution_revision) throw invalid();
  const view = parseNativeCompatibilityView(raw.view);
  if (view.installation_id !== request.installation_id || view.data_id !== request.data_id
    || view.source_revision !== request.expected_revision) throw invalid();
  // Frame parity (unchanged family state) plus candidate parity: the merged view is
  // expected to carry exactly the candidate's wire identity. updated_at can never be
  // compared: every native merge stamps the wall clock at preview time.
  if (view.schema_version !== current.schema_version || view.source_state !== current.source_state
    || view.resolution_revision !== current.resolution_revision || view.project_shadowed !== false
    || view.version !== current.version || view.application !== 'next_service_start'
    || view.enabled !== request.view.enabled || view.hostname !== request.view.hostname
    || view.port !== request.view.port || view.username !== request.view.username
    || view.updated_at !== null && typeof view.updated_at !== 'string') throw invalid();
  const action = request.password.action;
  const matches = action === 'keep'
    ? view.password.configured === current.password.configured && view.password.source === current.password.source
    : action === 'replace'
      ? view.password.configured === true && view.password.source === 'restricted local config'
      : view.password.configured === false && view.password.source === null
        || view.password.configured === true && view.password.source === 'environment';
  if (!matches) throw invalid();
  return view;
}

export async function saveNativeCompatibility(request: NativeCompatibilityPreviewRequest, operationId: string,
  signal: AbortSignal): Promise<NativeCompatibilityReceipt> {
  if (authorityState() !== 'ready' || !OPERATION_ID.test(operationId)) throw new NativeCompatibilityFailure('nnd_compatibility_unavailable');
  return parseReceipt(await call('/save', 'POST', signal, { ...request, operation_id: operationId }), request,
    operationId, request.expected_revision);
}
export async function inspectNativeCompatibilityOperation(identity: { installation_id: string; data_id: string },
  operationId: string, signal: AbortSignal): Promise<NativeCompatibilityReceipt | null> {
  if (!OPERATION_ID.test(operationId)) throw new NativeCompatibilityFailure('nnd_compatibility_request_invalid');
  try { return parseReceipt(await call(`/operations/${operationId}`, 'GET', signal), identity, operationId); }
  catch (error) { if (error instanceof NativeCompatibilityFailure && error.code === 'operation_not_found') return null; throw error; }
}

function parseReceipt(raw: unknown, identity: { installation_id: string; data_id: string }, operationId: string,
  expectedRevision?: string): NativeCompatibilityReceipt {
  if (!record(raw) || raw.installation_id !== identity.installation_id || raw.data_id !== identity.data_id
    || raw.scope !== 'user' || raw.operation_id !== operationId
    || !['saved', 'unpublished', 'unknown'].includes(String(raw.persistence))
    || typeof raw.before_revision !== 'string' || !REVISION.test(raw.before_revision)
    || expectedRevision !== undefined && raw.before_revision !== expectedRevision
    || !(raw.persisted_revision === null || typeof raw.persisted_revision === 'string' && PERSISTED_REVISION.test(raw.persisted_revision))
    || raw.persistence === 'saved' && raw.persisted_revision === null || raw.application !== 'next_service_start'
    || raw.next_action !== (raw.persistence === 'saved' ? 'next_service_start' : 'inspect_native_operation')
    || typeof raw.replayed !== 'boolean' || raw.replay_window !== 'last_128_operations') throw invalid();
  return { installation_id: raw.installation_id as string, data_id: raw.data_id as string, scope: 'user',
    operation_id: operationId, persistence: raw.persistence as NativeCompatibilityReceipt['persistence'],
    before_revision: raw.before_revision as string, persisted_revision: raw.persisted_revision as string | null,
    application: 'next_service_start',
    next_action: raw.next_action as NativeCompatibilityReceipt['next_action'],
    replayed: raw.replayed as boolean, replay_window: 'last_128_operations' };
}
