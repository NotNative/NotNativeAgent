// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA secrets metadata family contract (20261006-8).
 * The census classifies six secrets rows (label, kind, scope, metadata.{name},
 * fields.{field}, enabled) observed through the native broker over the encrypted-at-rest
 * vault secrets/vault.json. This is the READ half: the reader carries the broker's
 * redaction-safe publicSecret envelope exactly — field NAMES only, never a secret
 * value, never encrypted material — plus an absent-as-absent empty roster and honest
 * vault failures (the vault's own codes; a corrupt or unreadable vault never degrades
 * to an empty list). Every mutation stays on the runtime broker surface and its action
 * rows, so this surface must never become a vault/master-key editor: the client exposes
 * no composers and no mutation calls. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/secrets';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SECRET_ID = /^sec_[0-9a-f-]{36}$/u;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
// NNA binds the response to a 2 MiB + 65,536 ceiling sized for a local realm's public
// records; the client keeps the same cap so a drifted projection refuses locally too.
export const SECRETS_RESPONSE_BOUNDS = 2_097_152 + 65_536;

export class NativeSecretsFailure extends Error { constructor(readonly code: string) { super(code); } }
const viewInvalid = () => new NativeSecretsFailure('nnd_secrets_view_invalid');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface PublicSecretScope { kind: string; id: string }
export interface PublicSecretMetadata {
  [name: string]: null | boolean | string | readonly string[] }
export interface NativeSecretRecord { id: string; realm: string; label: string; kind: string;
  scope: PublicSecretScope | null; metadata: PublicSecretMetadata; fields: readonly string[];
  enabled: boolean; created_at: string; updated_at: string; rotated_at: string | null;
  last_used_at: string | null; use_count: number }
export interface NativeSecretsList {
  schema_version: '1.0';
  installation_id: string; data_id: string; scope: 'user'; source_state: 'present' | 'absent';
  count: number; secrets: readonly NativeSecretRecord[]; application: 'next_secret_use'; }
export interface NativeSecretsCatalogField {
  path: 'label' | 'kind' | 'scope' | 'metadata.{name}' | 'fields.{field}' | 'enabled';
  classification: 'operator_setting'; application: 'next_secret_use'; scope: 'user';
  required_permission: 'nnd.configuration.read';
  editability: { available: false; scope: 'user'; reason: 'secret_broker_actions' }; }
export interface NativeSecretsCatalog {
  schema_version: '1.0'; source: 'secrets'; scope: 'user';
  fields: readonly NativeSecretsCatalogField[]; }

const KINDS = ['api_key', 'token', 'username_password', 'text'];
const SCOPE_KINDS = ['deployment', 'workspace', 'group', 'role', 'user'];
const LIST_KEYS = 'application,count,data_id,installation_id,schema_version,scope,secrets,source_state';
const RECORD_KEYS = 'created_at,enabled,fields,id,kind,label,last_used_at,metadata,'
  + 'realm,rotated_at,scope,updated_at,use_count';

export async function readNativeSecretsList(signal: AbortSignal): Promise<NativeSecretsList> {
  return parseNativeSecretsList(await call('', signal));
}
export async function readNativeSecretsCatalog(signal: AbortSignal): Promise<NativeSecretsCatalog> {
  return parseNativeSecretsCatalog(await call('/catalog', signal));
}

export function parseNativeSecretsList(raw: unknown): NativeSecretsList {
  if (!record(raw) || Object.keys(raw).sort().join(',') !== LIST_KEYS
    || raw.schema_version !== '1.0' || raw.scope !== 'user' || raw.application !== 'next_secret_use'
    || raw.source_state !== 'present' && raw.source_state !== 'absent'
    || !Array.isArray(raw.secrets) || !Number.isSafeInteger(raw.count)) throw viewInvalid();
  if (typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id)) throw viewInvalid();
  if (raw.count !== raw.secrets.length
    || raw.source_state === 'absent' && raw.secrets.length !== 0) throw viewInvalid();
  const secrets = raw.secrets.map((item) => {
    if (!record(item) || Object.keys(item).sort().join(',') !== RECORD_KEYS) throw viewInvalid();
    if (typeof item.id !== 'string' || !SECRET_ID.test(item.id) || item.realm !== 'nna.local') throw viewInvalid();
    const label = item.label;
    if (typeof label !== 'string' || label.length < 1 || label.length > 96
      || /[\x00-\x1f\x7f]/u.test(label)) throw viewInvalid();
    if (typeof item.kind !== 'string' || !KINDS.includes(item.kind)) throw viewInvalid();
    if (item.enabled !== true && item.enabled !== false) throw viewInvalid();
    if (typeof item.use_count !== 'number' || !Number.isSafeInteger(item.use_count) || item.use_count < 0) {
      throw viewInvalid();
    }
    return { id: item.id, realm: item.realm, label,
      kind: item.kind, scope: parseScope(item.scope), metadata: parseMetadata(item.metadata),
      fields: parseFieldNames(item.fields), enabled: item.enabled,
      created_at: stamp(item.created_at), updated_at: stamp(item.updated_at),
      rotated_at: optionalStamp(item.rotated_at), last_used_at: optionalStamp(item.last_used_at),
      use_count: item.use_count };
  });
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id, scope: 'user',
    source_state: raw.source_state as NativeSecretsList['source_state'], count: secrets.length,
    secrets, application: 'next_secret_use' };
}

function parseScope(value: unknown): PublicSecretScope | null {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).sort().join(',') !== 'id,kind'
    || typeof value.kind !== 'string' || !SCOPE_KINDS.includes(value.kind)
    || typeof value.id !== 'string' || value.id.length < 1 || value.id.length > 128
    || /[\x00-\x1f\x7f]/u.test(value.id)) throw viewInvalid();
  return { kind: value.kind, id: value.id };
}

function parseMetadata(value: unknown): PublicSecretMetadata {
  if (value === null || !record(value)) throw viewInvalid();
  const entries = Object.entries(value);
  if (entries.length > 32) throw viewInvalid();
  return Object.fromEntries(entries.map(([name, item]) => {
    if (!FIELD_NAME.test(name)) throw viewInvalid();
    if (item === null || typeof item === 'boolean') return [name, item];
    if (typeof item === 'string' && item.length <= 2_000
      && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(item)) return [name, item];
    if (Array.isArray(item) && item.length <= 64
      && item.every((entry) => typeof entry === 'string' && entry.length <= 256)
      && item.every((entry, index) => index === 0 || String(item[index - 1]) <= String(entry))) {
      return [name, Object.freeze([...item])];
    }
    throw viewInvalid();
  }));
}

function parseFieldNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 16) throw viewInvalid();
  const seen = new Set<string>();
  return value.map((name, index) => {
    if (typeof name !== 'string' || !FIELD_NAME.test(name) || seen.has(name)
      || (index > 0 && String(value[index - 1]) >= String(name))) throw viewInvalid();
    seen.add(name);
    return name;
  });
}

function stamp(value: unknown): string {
  if (typeof value === 'string' && ISO_STAMP.test(value)) return value;
  throw viewInvalid();
}

function optionalStamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && ISO_STAMP.test(value)) return value;
  throw viewInvalid();
}

export function parseNativeSecretsCatalog(raw: unknown): NativeSecretsCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'secrets' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== 6) throw viewInvalid();
  const paths = ['label', 'kind', 'scope', 'metadata.{name}', 'fields.{field}', 'enabled'];
  const fields = raw.fields as Record<string, unknown>[];
  const normalized = fields.map((field, index) => {
    if (!record(field) || field.path !== paths[index] || field.classification !== 'operator_setting'
      || field.application !== 'next_secret_use' || field.scope !== 'user'
      || field.required_permission !== 'nnd.configuration.read' || !record(field.editability)
      || field.editability.available !== false || field.editability.scope !== 'user'
      || field.editability.reason !== 'secret_broker_actions') throw viewInvalid();
    return field as unknown as NativeSecretsCatalogField;
  });  return { schema_version: '1.0', source: 'secrets', scope: 'user', fields: normalized };
}

async function call(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await runtimeFetch(BASE + path, { method: 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  const payload = await boundedJson(response, SECRETS_RESPONSE_BOUNDS);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = typeof error?.code === 'string' ? error.code
      : response.status === 404 ? 'nnd_secrets_unsupported' : 'nnd_secrets_unavailable';
    throw new NativeSecretsFailure(code);
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

export function secretsErrorText(code: string): string {
  if (code === 'nnd_secrets_unsupported') return 'This NNA does not expose native secrets metadata.';
  if (code === 'secret_vault_corrupt' || code === 'secret_key_invalid'
    || code === 'secret_vault_integrity_failed') return 'The secret vault needs native repair before its metadata can be read.';
  return 'Secrets metadata could not be read.';
}
