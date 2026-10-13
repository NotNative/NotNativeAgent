// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA trusted-workspaces family contract (20261006-5).
 * The trust rows govern which workspace roots may contribute project configuration
 * and skills. The family has no CAS manifest and no preview: grant/revoke run through
 * the native trust functions, and the receipt records the CANONICAL root, which may
 * differ from the requested path (symlink resolution). Reads claim nothing when the
 * store is unreadable: the server surfaces workspace_trust_invalid instead of an
 * empty list, because "nothing trusted" would admit unsafe flows.
 * Invariant: the parsed list carries exactly the three census paths in the served
 * order; a workspace entry carries exactly root and trusted_at; receipts are matched
 * to the requested operation so a replay of another operation cannot pass.
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const API_BASE = '/api/v1/nnd/configuration/trust';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const PATHS = ['version', 'workspaces[*].root', 'workspaces[*].trustedAt'];
// Loose ceiling mirrored from the native route: a legal store projects at roughly its
// own byte size (re-escalated keys at most 1:1, native probe worst ~310k with fixed
// keys and envelope), so anything beyond this is projector drift and fails closed.
const LIST_BOUNDS = 2_162_688;
const CATALOG_BOUNDS = 65536;
// Receipt ceiling mirroring the native one: the largest legal canonical root
// (32,767 UTF-16 units, ≤2 bytes per unit escaping) plus the fixed envelope.
const RECEIPT_BOUNDS = 131_072;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new NativeTrustFailure('nnd_trust_request_invalid');
export class NativeTrustFailure extends Error { constructor(readonly code: string) { super(code); } }

export interface NativeTrustWorkspace { root: string; trusted_at: string }
export interface NativeTrustListView { schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'user'; version: number; workspaces: readonly NativeTrustWorkspace[]; source: 'trust';
  application: 'project_configuration'; fields: readonly string[] }
export interface NativeTrustReceipt { schema_version: '1.0'; installation_id: string; data_id: string;
  scope: 'user'; operation: 'grant' | 'revoke'; root: string; trusted: boolean;
  application: 'project_configuration' }
export type NativeTrustCatalogField = { path: 'version'; classification: 'generated_state';
  application: 'project_configuration'; editability: { available: false; scope: 'user'; reason: 'generated_state' } }
  | { path: 'workspaces[*].root'; classification: 'authority_grant'; application: 'project_configuration';
    operations: readonly ['grant', 'revoke']; required_permission: 'nnd.workspace.manage';
    editability: { available: true; scope: 'user'; required_permission: 'nnd.workspace.manage' } }
  | { path: 'workspaces[*].trustedAt'; classification: 'generated_state'; application: 'project_configuration';
    editability: { available: false; scope: 'user'; reason: 'generated_state' } };
export interface NativeTrustCatalog { schema_version: '1.0'; source: 'trust'; scope: 'user';
  fields: readonly NativeTrustCatalogField[] }

/** The largest legal canonical root: 32,767 UTF-16 units at ≤2 escaped bytes. */
function receiptRoot(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 65_536) throw invalid();
  return value;
}

export function parseNativeTrustList(raw: unknown): NativeTrustListView {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string' || !ID.test(raw.installation_id)
    || typeof raw.data_id !== 'string' || !ID.test(raw.data_id) || raw.scope !== 'user'
    || raw.version !== 1 || !Array.isArray(raw.workspaces) || raw.source !== 'trust'
    || raw.application !== 'project_configuration') throw invalid();
  const workspaces = raw.workspaces.map((item) => {
    if (!record(item) || Object.keys(item).sort().join(',') !== 'root,trusted_at'
      || typeof item.root !== 'string' || item.root.length < 1
      || typeof item.trusted_at !== 'string') throw invalid();
    return { root: item.root, trusted_at: item.trusted_at };
  });
  if (!Array.isArray(raw.fields) || raw.fields.length !== PATHS.length
    || !raw.fields.every((path: unknown, index) => path === PATHS[index])) throw invalid();
  // The rebuilt view keeps the served key order; unknown future keys are dropped.
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id,
    scope: 'user', version: 1, workspaces, source: 'trust', application: 'project_configuration',
    fields: [...raw.fields] };
}

export function parseNativeTrustReceipt(raw: unknown, operation: 'grant' | 'revoke'): NativeTrustReceipt {
  if (!record(raw) || raw.schema_version !== '1.0' || typeof raw.installation_id !== 'string'
    || !ID.test(raw.installation_id) || typeof raw.data_id !== 'string' || !ID.test(raw.data_id)
    || raw.scope !== 'user' || raw.operation !== operation || raw.trusted !== (operation === 'grant')
    || raw.application !== 'project_configuration') throw invalid();
  return { schema_version: '1.0', installation_id: raw.installation_id, data_id: raw.data_id,
    scope: 'user', operation, root: receiptRoot(raw.root), trusted: operation === 'grant',
    application: 'project_configuration' };
}

export function parseNativeTrustCatalog(raw: unknown): NativeTrustCatalog {
  if (!record(raw) || raw.schema_version !== '1.0' || raw.source !== 'trust' || raw.scope !== 'user'
    || !Array.isArray(raw.fields) || raw.fields.length !== PATHS.length) throw invalid();
  const fields = raw.fields.map((field, index): NativeTrustCatalogField => {
    if (!record(field) || field.path !== PATHS[index] || field.application !== 'project_configuration') throw invalid();
    if (field.path === 'workspaces[*].root') {
      const editability = field.editability;
      if (field.classification !== 'authority_grant' || !record(editability)
        || editability.available !== true || editability.scope !== 'user'
        || editability.required_permission !== 'nnd.workspace.manage'
        || Array.isArray(field.operations) === false
        || (field.operations as readonly string[]).join(',') !== 'grant,revoke'
        || field.required_permission !== 'nnd.workspace.manage') throw invalid();
      return { path: 'workspaces[*].root', classification: 'authority_grant',
        application: 'project_configuration', operations: ['grant', 'revoke'],
        required_permission: 'nnd.workspace.manage',
        editability: { available: true, scope: 'user', required_permission: 'nnd.workspace.manage' } };
    }
    const generatedEditability = field.editability;
    if (field.classification !== 'generated_state' || !record(generatedEditability)
      || generatedEditability.available !== false || generatedEditability.scope !== 'user'
      || generatedEditability.reason !== 'generated_state') throw invalid();
    return field.path === 'version'
      ? { path: 'version', classification: 'generated_state', application: 'project_configuration',
        editability: { available: false, scope: 'user', reason: 'generated_state' } }
      : { path: 'workspaces[*].trustedAt', classification: 'generated_state',
        application: 'project_configuration',
        editability: { available: false, scope: 'user', reason: 'generated_state' } };
  });
  return { schema_version: '1.0', source: 'trust', scope: 'user', fields };
}

export function isValidTrustWorkspaceDraft(value: unknown): value is string {
  // Mirrors the native ROOT_MAX (the chunked realpath input space), not a semantic cap.
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 32_768;
}

class JsonError extends NativeTrustFailure { constructor() { super('nnd_trust_request_invalid'); } }
export async function readNativeTrustList(signal: AbortSignal): Promise<NativeTrustListView> {
  return parseNativeTrustList(await call('', signal, LIST_BOUNDS));
}
export async function readNativeTrustCatalog(signal: AbortSignal): Promise<NativeTrustCatalog> {
  return parseNativeTrustCatalog(await call('/catalog', signal, CATALOG_BOUNDS));
}
async function trustOperation(operation: 'grant' | 'revoke', root: string, signal: AbortSignal) {
  if (!isValidTrustWorkspaceDraft(root)) throw new NativeTrustFailure('nnd_trust_request_invalid');
  const receipt = await call(`/${operation}`, signal, RECEIPT_BOUNDS, { root: root.trim() });
  return parseNativeTrustReceipt(receipt, operation);
}
export const grantNativeWorkspaceTrust = (root: string, signal: AbortSignal) =>
  trustOperation('grant', root, signal);
export const revokeNativeWorkspaceTrust = (root: string, signal: AbortSignal) =>
  trustOperation('revoke', root, signal);

async function call(path: string, signal: AbortSignal, bounds: number, body?: { root: string }):
  Promise<unknown> {
  if (authorityState() !== 'ready') throw new NativeTrustFailure('nnd_workspace_trust_unavailable');
  const response = await runtimeFetch(API_BASE + path, { method: body ? 'POST' : 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const payload = await boundedJson(response, bounds);
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).error : null;
    const code = error && typeof error === 'object' && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).code === 'string'
      && CODE.test(String((error as Record<string, unknown>).code))
      ? String((error as Record<string, unknown>).code)
      : response.status === 404 ? 'nnd_trust_unsupported' : 'nnd_workspace_trust_unavailable';
    throw new NativeTrustFailure(code);
  }
  return payload;
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeTrustFailure('nnd_workspace_trust_unavailable');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > bounds) { void reader.cancel().catch(() => undefined); throw new JsonError(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new JsonError();
  }
}

export const trustMessages: Record<string, string> = {
  nnd_trust_request_invalid: 'The trust request was not understood in the supported shape.',
  nnd_trust_unsupported: 'The native trust surface does not carry the requested operation.',
  nnd_workspace_trust_unavailable: 'Native workspace trust cannot be read right now.',
  nnd_configuration_unavailable: 'The native trust surface is unavailable in this NNA build.',
  workspace_trust_invalid: 'The native trust store is unreadable (corrupt or oversized); it refuses to claim which roots are trusted.',
  workspace_trust_target_missing: 'That workspace path does not exist, so it cannot be granted.',
  workspace_trust_busy: 'The native trust store is busy with another grant or revoke; retry shortly.',
  request_too_large: 'That workspace path was too long for the trust envelope.',
  request_invalid: 'The trust request body was not valid JSON in the supported shape.',
  integration_permission_denied: 'This account lacks the workspace authority required to grant or revoke trust.',
  network_unreachable: 'The native service is unreachable.',
  service_invalid: 'The native service endpoint config is not usable.',
};
