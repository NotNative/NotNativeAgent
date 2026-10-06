// SPDX-License-Identifier: Apache-2.0
/** NND side of the census secret_action family (20261006-11).
 * The seven operator_action rows (list/create/update/rotate/enable_disable/
 * delete/audit) ride the runtime SecretBroker surface the NNA integration server
 * already serves — /v1/secrets and /v1/secrets/:id — dispatched by
 * dispatchSecretBrokerRequest with SecretBroker as the verbatim authority. This
 * client is the SETTINGS-side console: it presents the broker's own redacted
 * publicSecret roster, sends typed field values as create/rotate inputs, and
 * reads the audit ledger. Two rules never bend: secret VALUES flow out only
 * (typed into a form; sent; never fetched and never rendered anywhere — there is
 * deliberately no client for POST /v1/secrets/:id/use, the consumer path the
 * runtime reserves for trusted local callers with secret.use, a right the NND
 * operator does not hold), and every mutation returns the broker's redacted
 * receipt, so the console can only ever display what the broker itself shows:
 * labels, kinds, scopes, field NAMES, and enablement. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/secrets';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SECRET_ID = /^sec_[0-9a-f-]{36}$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const ISO_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
// The broker binds bodies to 96 KB; the response cap keeps the same family
// allowance as the settings reads.
const RESPONSE_BYTES = 1_048_576;
export const SECRET_KINDS = ['api_key', 'token', 'username_password', 'text'] as const;
export const SECRET_SCOPE_KINDS = ['deployment', 'workspace', 'group', 'role', 'user'] as const;
const REALM = 'nna.local';

export class NativeSecretActionFailure extends Error { constructor(readonly code: string) { super(code); } }
const viewInvalid = () => new NativeSecretActionFailure('nnd_secret_action_view_invalid');
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface PublicSecret { id: string; realm: string; label: string; kind: SecretKindName;
  scope: { kind: SecretScopeName; id: string } | null; metadata: Record<string, unknown>;
  fields: readonly string[]; enabled: boolean; createdAt: string; updatedAt: string;
  rotatedAt: string | null; lastUsedAt: string | null; useCount: number }
export type SecretKindName = (typeof SECRET_KINDS)[number];
export type SecretScopeName = (typeof SECRET_SCOPE_KINDS)[number];
export interface SecretAuditEvent { format: 1; id: string; at: string; event: SecretEventName;
  outcome: 'succeeded' | 'failed'; realm: string; secretId: string;
  scope: { kind: SecretScopeName; id: string } | null; consumer: string | null;
  destination: string | null; purpose: string | null; sessionId: string | null;
  reviewerDecisionId: string | null; reason: string | null }
export type SecretEventName = 'secret.created' | 'secret.updated' | 'secret.rotated'
  | 'secret.enabled' | 'secret.deleted' | 'secret.used' | 'secret.read' | 'secret.listed';
export interface SecretDraftInput { label?: string; kind?: SecretKindName;
  fields?: Record<string, string>; scope?: { kind: SecretScopeName; id: string } | null;
  metadata?: Record<string, unknown>; enabled?: boolean }

export async function readBrokerSecrets(signal: AbortSignal): Promise<readonly PublicSecret[]> {
  const raw = envelope(await call('', 'GET', undefined, signal, 200), ['secrets']);
  const secrets = raw.secrets as unknown[];
  return secrets.map((secret: unknown, index: number) => parsePublicSecret(secret, index));
}
export async function readSecretAudit(signal: AbortSignal, limit = 100): Promise<readonly SecretAuditEvent[]> {
  const raw = envelope(await call(`/audit?limit=${limit}`, 'GET', undefined, signal, 200), ['events']);
  const events = raw.events as unknown[];
  return events.map((entry: unknown, index: number) => parseAuditEvent(entry, index));
}
export async function createSecret(draft: SecretDraftInput, signal: AbortSignal): Promise<PublicSecret> {
  const raw = envelope(await call('', 'POST', draft, signal, 201), ['secret']);
  return parsePublicSecret(raw.secret as unknown, 0);
}
export async function updateSecret(id: string, patch: SecretDraftInput, signal: AbortSignal): Promise<PublicSecret> {
  const raw = envelope(await call(`/${id}`, 'PATCH', patch, signal, 200), ['secret']);
  return parsePublicSecret(raw.secret as unknown, 0);
}
export async function rotateSecret(id: string, fieldValues: Record<string, string>,
  signal: AbortSignal): Promise<PublicSecret> {
  const raw = envelope(await call(`/${id}/values`, 'PUT', { fields: fieldValues }, signal, 200), ['secret']);
  return parsePublicSecret(raw.secret as unknown, 0);
}
export async function setSecretEnabled(id: string, enabled: boolean,
  signal: AbortSignal): Promise<PublicSecret> {
  const raw = envelope(await call(`/${id}/status`, 'PATCH', { enabled }, signal, 200), ['secret']);
  return parsePublicSecret(raw.secret as unknown, 0);
}
export async function deleteSecret(id: string, signal: AbortSignal): Promise<'removed'> {
  const raw = envelope(await call(`/${id}`, 'DELETE', undefined, signal, 200), ['ok']);
  if (raw.ok !== true) throw viewInvalid();
  return 'removed';
}

/** The redacted record the broker itself projects; a value can never appear
 * because every fields entry must be a NAME, never a value-shaped entry. */
export function parsePublicSecret(row: unknown, index: number): PublicSecret {
  const labels = ['createdAt', 'enabled', 'fields', 'id', 'kind', 'label', 'lastUsedAt', 'metadata',
    'realm', 'rotatedAt', 'scope', 'updatedAt', 'useCount'];
  if (!record(row) || Object.keys(row).length !== labels.length
    || labels.some(key => !(key in row))) {
    throw new NativeSecretActionFailure(index === 0 ? 'secret_broker_unavailable' : 'nnd_secret_action_view_invalid');
  }
  if (typeof row.id !== 'string' || !SECRET_ID.test(row.id)
    || row.realm !== REALM
    || typeof row.label !== 'string' || row.label.length < 1 || row.label.length > 96
    || ISO_CONTROLS.test(row.label)
    || typeof row.kind !== 'string' || !SECRET_KINDS.includes(row.kind as SecretKindName)) {
    throw viewInvalid();
  }
  if (typeof row.enabled !== 'boolean' || !Array.isArray(row.fields) || row.fields.length < 1
    || row.fields.length > 16 || row.fields.some((name: unknown) => typeof name !== 'string'
      || !FIELD_NAME.test(name))) throw viewInvalid();
  for (let position = 1; position < (row.fields as string[]).length; position += 1) {
    if (String((row.fields as string[])[position - 1]) >= String((row.fields as string[])[position])) {
      throw viewInvalid();
    }
  }
  if (row.scope !== null && !scopeShape(row.scope)) throw viewInvalid();
  if (!metadataShape(row.metadata)) throw viewInvalid();
  if (typeof row.createdAt !== 'string' || !STAMP.test(row.createdAt)
    || typeof row.updatedAt !== 'string' || !STAMP.test(row.updatedAt)
    || (row.rotatedAt !== null && (typeof row.rotatedAt !== 'string' || !STAMP.test(row.rotatedAt)))
    || (row.lastUsedAt !== null && (typeof row.lastUsedAt !== 'string' || !STAMP.test(row.lastUsedAt)))) {
    throw viewInvalid();
  }
  if (typeof row.useCount !== 'number' || !Number.isSafeInteger(row.useCount) || row.useCount < 0) {
    throw viewInvalid();
  }
  return { ...row, fields: [...row.fields as string[]] } as unknown as PublicSecret;
}

function scopeShape(value: unknown): boolean {
  return record(value) && Object.keys(value).sort().join(',') === 'id,kind'
    && typeof value.kind === 'string' && SECRET_SCOPE_KINDS.includes(value.kind as SecretScopeName)
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
    && !ISO_CONTROLS.test(value.id);
}

function metadataShape(value: unknown): boolean {
  return record(value) && Object.keys(value).length <= 32
    && Object.keys(value).every(name => FIELD_NAME.test(name))
    && Object.values(value).every(item => item === null || typeof item === 'boolean'
      || (typeof item === 'string' && item.length <= 2_000 && !ISO_CONTROLS.test(item))
      || (Array.isArray(item) && item.length <= 64
        && item.every((entry: unknown) => typeof entry === 'string' && entry.length <= 256)));
}

export function parseAuditEvent(row: unknown, index: number): SecretAuditEvent {
  if (!record(row) || row.format !== 1
    || typeof row.id !== 'string' || !ID.test(row.id)
    || typeof row.at !== 'string' || !STAMP.test(row.at)
    || typeof row.event !== 'string'
    || !['secret.created', 'secret.updated', 'secret.rotated', 'secret.enabled', 'secret.deleted',
      'secret.used', 'secret.read', 'secret.listed'].includes(row.event)
    || (row.outcome !== 'succeeded' && row.outcome !== 'failed')
    || row.realm !== REALM
    || typeof row.secretId !== 'string' || !SECRET_ID.test(row.secretId)
    || (row.scope !== null && !scopeShape(row.scope))) {
    throw new NativeSecretActionFailure(index === 0 ? 'secret_audit_unavailable' : 'nnd_secret_action_view_invalid');
  }
  for (const key of ['consumer', 'destination', 'purpose', 'sessionId', 'reviewerDecisionId', 'reason']) {
    if (row[key] !== null && (typeof row[key] !== 'string' || row[key].length > 2_048
      || /[\x00-\x1f\x7f]/u.test(row[key]))) throw viewInvalid();
  }
  if (Object.keys(row).length !== 14) throw viewInvalid();
  return row as unknown as SecretAuditEvent;
}

function envelope(raw: unknown, legalKeys: readonly string[]): Record<string, unknown> {
  if (!record(raw) || Object.keys(raw).sort().join(',') !== [...legalKeys].sort().join(',')) {
    throw viewInvalid();
  }
  return raw;
}

async function call(path: string, method: string, body: unknown, signal: AbortSignal, ok: number): Promise<unknown> {
  const response = await runtimeFetch(`${BASE}${path}`, { method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > RESPONSE_BYTES) throw viewInvalid();
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw viewInvalid(); }
  if (response.status !== ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    throw new NativeSecretActionFailure(typeof error?.code === 'string' ? error.code
      : response.status === 404 ? 'secret_not_found' : 'secret_broker_unavailable');
  }
  return payload;
}

export function secretActionErrorText(code: string): string {
  if (code === 'secret_label_duplicate') return 'A secret with that label already exists.';
  if (code === 'secret_scope_forbidden') return 'This identity cannot manage the requested ownership scope.';
  if (code === 'secret_not_found') return 'The secret was not found natively (it may have been removed).';
  if (code === 'secret_fields_invalid' || code === 'secret_field_name_invalid'
    || code === 'secret_field_value_invalid') return 'The field values were refused natively; check the field names and bounds.';
  if (code === 'secret_label_invalid' || code === 'secret_kind_invalid' || code === 'secret_scope_invalid'
    || code === 'secret_metadata_invalid' || code === 'secret_status_invalid') {
    return 'The secret draft was refused natively; correct the draft and try again.';
  }
  if (code === 'secret_broker_unavailable' || code === 'secret_audit_unavailable'
    || code === 'nnd_secret_action_unavailable') return 'The native secret broker is unavailable.';
  if (code === 'nnd_secret_action_view_invalid') return 'The refused projection failed its sentence check instead.';
  return 'The secret action could not be completed natively.';
}
