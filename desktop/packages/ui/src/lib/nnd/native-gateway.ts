// SPDX-License-Identifier: Apache-2.0
/** Narrow, redacted NNA gateway settings family contract (20261005-14).
 * The token value itself is never modeled here: reads project presence only and saves carry
 * dedicated replace/clear operations. Authority ids change through authorize/revoke only.
 * Why: the GUI needs one typed surface for the whole gateway settings family without ever
 * holding, logging, or diffing the Telegram token.
 * Invariant: only the fields NNA's projector whitelists (minus the token) are accepted, and
 * every local candidate computation mirrors NNA's operation grammar exactly.
 * Compatibility: the legacy first-party flat polling request is intentionally not sent by
 * this client; NNA keeps serving it for older consumers only. */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration/gateway';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const TOKEN_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/u;
// Compatibility: mirror the NNA gateway domain's numeric Telegram id shape (no zero, no leading zeros).
const USER_ID = /^[1-9][0-9]{0,19}$/u;
// Compatibility: mirror the NNA projector's workspace read bound (any string up to 4096 or null);
// writes stay stricter via the gateway set-side absolute-path rule in validateOperation.
const readWorkspaceRoot = (value: unknown): value is string | null => value === null
  || typeof value === 'string' && value.length <= 4096;
const WORKSPACE = /^(?:[A-Za-z]:[\\/]|[\\/])/u;
// Compatibility: mirror the NNA projector's bounded stamp shape rather than over-stating ISO strictness.
const UPDATED_AT = /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,19}Z$/u;
const REQUEST_BOUNDS = 8192;
const SET_FIELDS = ['enabled', 'token_env', 'workspace_root', 'polling_timeout_seconds'] as const;
const RECORD = /^[a-z][a-z0-9_]{0,63}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new NativeGatewayFailure('nnd_gateway_timeout_view_invalid');
const requestInvalid = () => new NativeGatewayFailure('nnd_gateway_timeout_request_invalid');
const timeout = (value: unknown): value is number =>
  Number.isInteger(value) && typeof value === 'number' && value >= 5 && value <= 50;
export class NativeGatewayFailure extends Error { constructor(readonly code: string) { super(code); } }

export interface NativeGatewayView { schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'present'; source_revision: string; resolution_revision: string; project_shadowed: false;
  version: number; enabled: boolean; token_present: boolean; token_env: string;
  authorized_user_ids: readonly string[]; workspace_root: string | null; polling_timeout_seconds: number;
  updated_at: string | null; application: 'not_applied' }
export type NativeGatewayCatalogField = { path: 'version' | 'updated_at'; classification: 'generated_state';
  application: 'restart_gateway'; editability: { available: false; scope: 'user'; reason: 'generated_state' } }
  | { path: 'enabled' | 'token_env' | 'polling_timeout_seconds'; classification: 'operator_setting';
    application: 'restart_gateway'; editability: { available: true; scope: 'user';
      required_permission: 'nnd.configuration.manage' } }
  | { path: 'token'; classification: 'operator_setting'; sensitivity: 'secret'; application: 'restart_gateway';
    editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } }
  | { path: 'authorized_user_ids'; classification: 'authority_grant'; application: 'restart_gateway';
    editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' } };
export interface NativeGatewayCatalog { schema_version: '1.0'; source: 'gateway'; scope: 'user';
  fields: readonly NativeGatewayCatalogField[] }
export type NativeGatewayOperation =
  | { op: 'set'; field: typeof SET_FIELDS[number]; value: boolean | string | number | null }
  | { op: 'reset'; field: typeof SET_FIELDS[number] }
  | { op: 'set_token'; token: string }
  | { op: 'clear_token' }
  | { op: 'authorize' | 'revoke'; user_id: string };
export interface NativeGatewayRequest { installation_id: string; data_id: string; scope: 'user';
  expected_revision: string; expected_resolution_revision: string; operations: readonly NativeGatewayOperation[] }
export interface NativeGatewayReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; before_revision: string; persisted_revision: string | null;
  application: 'not_applied'; next_action: 'restart_gateway' | 'inspect_native_operation'; replayed: boolean;
  replay_window: 'last_128_operations' }

const boundedToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 20 && value.length <= 512 && !/[\r\n]/u.test(value);
const workspace = (value: unknown): value is string | null => value === null
  || typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\r\n]/u.test(value) && WORKSPACE.test(value);
const updated = (value: unknown): value is string | null => value === null
  || typeof value === 'string' && UPDATED_AT.test(value);
const environment = (value: unknown): value is string => typeof value === 'string' && TOKEN_ENV.test(value);

export function parseNativeGatewayView(raw: unknown): NativeGatewayView {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id) || raw.scope !== 'user' || raw.source_state !== 'present'
    || typeof raw.source_revision !== 'string' || !REVISION.test(raw.source_revision)
    || raw.resolution_revision !== raw.source_revision || raw.project_shadowed !== false
    || raw.version !== 1 || typeof raw.enabled !== 'boolean'
    || typeof raw.token_present !== 'boolean' || !environment(raw.token_env)
    || !Array.isArray(raw.authorized_user_ids) || !raw.authorized_user_ids.every(item => typeof item === 'string' && USER_ID.test(item))
    || !readWorkspaceRoot(raw.workspace_root) || !timeout(raw.polling_timeout_seconds) || !updated(raw.updated_at)
    || raw.application !== 'not_applied') throw invalid();
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id, scope: 'user',
    source_state: 'present', source_revision: raw.source_revision, resolution_revision: raw.source_revision,
    project_shadowed: false, version: raw.version as number, enabled: raw.enabled, token_present: raw.token_present,
    token_env: raw.token_env as string, authorized_user_ids: Object.freeze([...raw.authorized_user_ids as string[]]),
    workspace_root: raw.workspace_root as string | null, polling_timeout_seconds: raw.polling_timeout_seconds,
    updated_at: raw.updated_at as string | null, application: 'not_applied' };
}

const CATALOG_PATHS = ['version', 'updated_at', 'enabled', 'token', 'token_env', 'authorized_user_ids',
  'workspace_root', 'polling_timeout_seconds'] as const;
function parseCatalog(raw: unknown): NativeGatewayCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'gateway' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== 8) throw invalid();
  const fields: NativeGatewayCatalogField[] = raw.fields.map(entry => {
    if (!record(entry) || !CATALOG_PATHS.includes(entry.path as typeof CATALOG_PATHS[number])
      || entry.application !== 'restart_gateway' || !record(entry.editability)) throw invalid();
    const editability = entry.editability as Record<string, unknown>;
    const base = { application: 'restart_gateway' as const };
    const permission = { available: true, scope: 'user', required_permission: 'nnd.configuration.manage' } as const;
    if (entry.path === 'version' || entry.path === 'updated_at') {
      if (entry.classification !== 'generated_state' || editability.available !== false
        || editability.reason !== 'generated_state' || editability.scope !== 'user') throw invalid();
      return { path: entry.path, classification: 'generated_state' as const, ...base,
        editability: { available: false as const, scope: 'user', reason: 'generated_state' as const } };
    }
    if (editability.available !== true || editability.scope !== 'user'
      || editability.required_permission !== 'nnd.configuration.manage') throw invalid();
    if (entry.path === 'token') {
      if (entry.classification !== 'operator_setting' || entry.sensitivity !== 'secret') throw invalid();
      return { path: 'token', classification: 'operator_setting' as const, sensitivity: 'secret' as const,
        ...base, editability: { ...permission } };
    }
    if (entry.path === 'authorized_user_ids') {
      if (entry.classification !== 'authority_grant') throw invalid();
      return { path: 'authorized_user_ids', classification: 'authority_grant' as const,
        ...base, editability: { ...permission } };
    }
    if (entry.classification !== 'operator_setting') throw invalid();
    return { path: entry.path as 'enabled' | 'token_env' | 'polling_timeout_seconds',
      classification: 'operator_setting' as const, ...base, editability: { ...permission } };
  });
  const seen = new Set(fields.map(field => field.path));
  if (seen.size !== 8) throw invalid();
  return { schema_version: '1.0', source: 'gateway', scope: 'user', fields };
}

const DEFAULT_TIMEOUT = 25;
const DEFAULT_TOKEN_ENV = 'NNA_TELEGRAM_BOT_TOKEN';
/** Mirror of NNA's reset defaults for the four resettable fields. */
const RESET_DEFAULTS: { enabled: false; token_env: string; workspace_root: null; polling_timeout_seconds: number } = {
  enabled: false, token_env: DEFAULT_TOKEN_ENV, workspace_root: null, polling_timeout_seconds: DEFAULT_TIMEOUT };

function validateOperation(operation: unknown): NativeGatewayOperation {
  if (!record(operation) || !RECORD.test(String(operation.op))) throw requestInvalid();
  const keys = Object.keys(operation).sort().join(',');
  if (operation.op === 'set' && keys === 'field,op,value' && typeof operation.field === 'string'
    && (SET_FIELDS as readonly string[]).includes(operation.field)) {
    const field = operation.field as typeof SET_FIELDS[number];
    if (field === 'enabled' && typeof operation.value === 'boolean') return { ...operation, field, value: operation.value } as NativeGatewayOperation;
    if (field === 'token_env' && environment(operation.value)) return { ...operation, field, value: operation.value } as NativeGatewayOperation;
    if (field === 'workspace_root' && workspace(operation.value)) return { ...operation, field, value: operation.value } as NativeGatewayOperation;
    if (field === 'polling_timeout_seconds' && timeout(operation.value)) return { ...operation, field, value: operation.value } as NativeGatewayOperation;
    throw requestInvalid();
  }
  if (operation.op === 'reset' && keys === 'field,op' && typeof operation.field === 'string'
    && (SET_FIELDS as readonly string[]).includes(operation.field)) return { ...operation } as NativeGatewayOperation;
  if (operation.op === 'set_token' && keys === 'op,token' && boundedToken(operation.token)) {
    return { op: 'set_token', token: operation.token };
  }
  if (operation.op === 'clear_token' && keys === 'op') return { op: 'clear_token' };
  if ((operation.op === 'authorize' || operation.op === 'revoke') && keys === 'op,user_id'
    && typeof operation.user_id === 'string' && USER_ID.test(operation.user_id)) {
    return { op: operation.op, user_id: operation.user_id };
  }
  throw requestInvalid();
}

/** Compose one bounded native change batch from the current settings view. */
export function nativeGatewayOperations(operations: readonly unknown[]): readonly NativeGatewayOperation[] {
  if (operations.length < 1 || operations.length > 16) throw requestInvalid();
  return Object.freeze(operations.map(operation => validateOperation(operation)));
}

export function nativeGatewayRequest(view: NativeGatewayView, operations: readonly NativeGatewayOperation[],
  ): NativeGatewayRequest {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 16
    || view.project_shadowed) throw requestInvalid();
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision, expected_resolution_revision: view.resolution_revision,
    operations: Object.freeze([...operations]) as readonly NativeGatewayOperation[] };
}

/** Local mirror of NNA's family transaction, used to verify that a preview really equals intent.
 * The authorized allowlist mirrors the gateway domain's normalization: dedupe plus
 * lexicographic sort happen once over the whole candidate, exactly as normalizeGatewayConfig does. */
export function projectNativeGatewayOperations(view: NativeGatewayView,
  operations: readonly NativeGatewayOperation[]): NativeGatewayView {
  let enabled = view.enabled, tokenEnv = view.token_env, workspaceRoot = view.workspace_root;
  let pollTimeout = view.polling_timeout_seconds, tokenPresent = view.token_present;
  const users = [...view.authorized_user_ids];
  for (const operation of operations) {
    if (operation.op === 'set') {
      if (operation.field === 'enabled') enabled = operation.value as boolean;
      else if (operation.field === 'token_env') tokenEnv = operation.value as string;
      else if (operation.field === 'workspace_root') workspaceRoot = operation.value as string | null;
      else pollTimeout = operation.value as number;
    } else if (operation.op === 'reset') {
      if (operation.field === 'enabled') enabled = RESET_DEFAULTS.enabled;
      else if (operation.field === 'token_env') tokenEnv = RESET_DEFAULTS.token_env;
      else if (operation.field === 'workspace_root') workspaceRoot = RESET_DEFAULTS.workspace_root;
      else pollTimeout = RESET_DEFAULTS.polling_timeout_seconds;
    } else if (operation.op === 'set_token') tokenPresent = true;
    else if (operation.op === 'clear_token') tokenPresent = false;
    else if (operation.op === 'authorize' && !users.includes(operation.user_id)) users.push(operation.user_id);
    else if (operation.op === 'revoke') {
      const at = users.indexOf(operation.user_id); if (at >= 0) users.splice(at, 1);
    }
  }
  const normalizedUsers = [...new Set(users)].sort();
  return { ...view, enabled, token_present: tokenPresent, token_env: tokenEnv,
    authorized_user_ids: Object.freeze(normalizedUsers), workspace_root: workspaceRoot,
    polling_timeout_seconds: pollTimeout };
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
    size += item.value.byteLength; if (size > REQUEST_BOUNDS) { await reader.cancel(); throw invalid(); } chunks.push(item.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
}

async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > REQUEST_BOUNDS) {
    throw new NativeGatewayFailure('nnd_gateway_timeout_request_invalid');
  }
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && RECORD.test(error.code) ? error.code
      : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
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
export async function previewNativeGateway(request: NativeGatewayRequest, current: NativeGatewayView,
  signal: AbortSignal): Promise<NativeGatewayView> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'not_applied'
    || raw.expected_revision !== request.expected_revision || raw.resolution_revision !== request.expected_resolution_revision) throw invalid();
  const view = parseNativeGatewayView(raw.view);
  if (view.installation_id !== request.installation_id || view.data_id !== request.data_id
    || view.source_revision !== request.expected_revision) throw invalid();
  // updated_at is stamped by the server transaction; a preview may carry a provisional
  // stamp that differs from the current file, so it is shape-validated but not compared.
  const expected = projectNativeGatewayOperations(current, request.operations);
  const same = ['version', 'enabled', 'token_present', 'token_env', 'workspace_root', 'polling_timeout_seconds']
    .every(key => JSON.stringify(view[key as keyof NativeGatewayView]) === JSON.stringify(expected[key as keyof NativeGatewayView]))
    && view.authorized_user_ids.join(',') === expected.authorized_user_ids.join(',');
  if (!same) throw invalid();
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
