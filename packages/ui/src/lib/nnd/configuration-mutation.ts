// SPDX-License-Identifier: Apache-2.0
/** NNA remains the sole authority for preview, CAS publication and repair. */
import { runtimeFetch } from '../runtime-fetch.ts';
import { parseNativeConfigurationView, type NativeConfigurationView } from './configuration.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const BASE = '/api/v1/nnd/configuration';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const revision = (value: unknown): value is string => typeof value === 'string' && REVISION.test(value);
const MAX_RESPONSE = 2 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export class NativeConfigurationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
export function newNativeOperationId(): string {
  // getRandomValues also works for a browser on an authenticated LAN HTTP origin.
  if (!globalThis.crypto?.getRandomValues) throw new NativeConfigurationFailure('nnd_configuration_unavailable');
  const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export interface NativeEditableField {
  path: string;
  type: 'integer' | 'number' | 'string' | 'boolean' | 'enum' | 'array';
  enum?: string[];
  editability: { available: true; scope: 'user'; required_permission: 'nnd.configuration.manage' };
}
export type NativeRouteRole = 'reviewer' | 'vision';
export interface NativeConfigurationCatalog { fields: NativeEditableField[]; routeBindings?: NativeRouteRole[] }
export type NativeOperation = { op: 'set' | 'reset'; field: string; value?: unknown }
  | { op: 'bind_route'; role: NativeRouteRole; provider_id: string; model: string };
export interface NativeChangeRequest {
  installation_id: string; data_id: string; scope: 'user'; expected_revision: string;
  expected_resolution_revision: string; operations: NativeOperation[];
}
export interface NativePreview { valid: true; expected_revision: string; resolution_revision: string;
  application: 'not_applied'; view: NativeConfigurationView }
export interface NativeReceipt { installation_id: string; data_id: string; scope: 'user'; operation_id: string;
  persistence: 'saved' | 'unpublished' | 'unknown'; persisted_revision: string | null;
  before_revision: string; application: 'not_applied'; replayed: boolean }

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeConfigurationFailure('nnd_configuration_unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw new NativeConfigurationFailure('nnd_configuration_view_invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new NativeConfigurationFailure('nnd_configuration_view_invalid'); }
}
async function call(path: string, method: 'GET' | 'POST', signal: AbortSignal, body?: unknown): Promise<unknown> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && new TextEncoder().encode(encoded).byteLength > 65536) throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  const response = await runtimeFetch(BASE + path, { method, signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    ...(encoded === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: encoded }) });
  const payload = await boundedJson(response);
  if (!response.ok) {
    const error = record(payload) && record(payload.error) ? payload.error : null;
    const code = error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
      ? error.code : record(payload) && payload.error === 'operation_not_found' ? 'operation_not_found'
        : response.status === 404 ? 'nnd_configuration_unsupported' : 'nnd_configuration_unavailable';
    throw new NativeConfigurationFailure(code);
  }
  return payload;
}
export async function requestNativeConfigurationCatalog(signal: AbortSignal): Promise<NativeConfigurationCatalog> {
  const response = await call('/catalog', 'GET', signal);
  if (!record(response) || response.schema_version !== '1.0' || response.authority !== 'descriptive_only'
    || !Array.isArray(response.fields) || response.fields.length > 512) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
  const fields: NativeEditableField[] = [];
  const bindingPaths = new Set<string>();
  for (const raw of response.fields) {
    if (!record(raw) || !record(raw.editability) || raw.editability.available !== true) continue;
    const role = /^routes\.(reviewer|vision)\.(provider_id|model)$/u.exec(String(raw.path))?.[1];
    if (role && raw.editability.operation === 'bind_route') {
      const paired = [`routes.${role}.provider_id`, `routes.${role}.model`];
      if (typeof raw.path !== 'string' || raw.type !== 'unknown' || raw.classification !== 'operator_setting'
        || raw.editability.scope !== 'user' || raw.editability.required_permission !== 'nnd.configuration.manage'
        || !Array.isArray(raw.editability.paired_fields)
        || JSON.stringify(raw.editability.paired_fields) !== JSON.stringify(paired)
        || bindingPaths.has(raw.path)) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
      bindingPaths.add(raw.path); continue;
    }
    if (typeof raw.path !== 'string' || raw.path.length > 512 || !ID.test(raw.path.replaceAll('.', '_'))
      || /^routes\.(?:reviewer|vision)\.(?:provider_id|model)$/u.test(raw.path)
      || raw.editability.operation !== undefined
      || !['integer', 'number', 'string', 'boolean', 'enum', 'array'].includes(String(raw.type))
      || raw.classification !== 'operator_setting' || raw.editability.generic_editable !== true
      || raw.editability.scope !== 'user' || raw.editability.required_permission !== 'nnd.configuration.manage'
      || raw.sensitivity === 'credential_reference') throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
    if (raw.type === 'enum' && (!Array.isArray(raw.enum) || raw.enum.length > 64 || raw.enum.some(item => typeof item !== 'string'))) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
    fields.push(raw as unknown as NativeEditableField);
  }
  if (new Set(fields.map(field => field.path)).size !== fields.length) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
  const routeBindings = (['reviewer', 'vision'] as NativeRouteRole[]).filter(role =>
    bindingPaths.has(`routes.${role}.provider_id`) && bindingPaths.has(`routes.${role}.model`));
  return { fields, routeBindings };
}
export function nativeRouteBindingChange(view: NativeConfigurationView, catalog: NativeConfigurationCatalog,
  role: NativeRouteRole, providerId: string, model: string): NativeChangeRequest {
  if (view.scope !== 'user' || view.source_state !== 'present' || !REVISION.test(view.source_revision ?? '')
    || !/^[a-f0-9]{64}$/u.test(view.resolution_revision ?? '') || !ID.test(view.installation_id)
    || !ID.test(view.data_id) || !catalog.routeBindings?.includes(role)
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(providerId) || ['__proto__', 'constructor', 'prototype'].includes(providerId)
    || !model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  }
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision!, expected_resolution_revision: view.resolution_revision!,
    operations: [{ op: 'bind_route', role, provider_id: providerId, model }] };
}
export function nativeChange(view: NativeConfigurationView, field: NativeEditableField,
  mode: 'set' | 'reset', draft: string): NativeChangeRequest {
  if (view.scope !== 'user' || view.source_state !== 'present' || !REVISION.test(view.source_revision ?? '')
    || !/^[a-f0-9]{64}$/u.test(view.resolution_revision ?? '') || !ID.test(view.installation_id) || !ID.test(view.data_id)
    || !field.editability.available || field.editability.scope !== 'user'
    || field.editability.required_permission !== 'nnd.configuration.manage') throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  let operation: NativeOperation = { op: 'reset', field: field.path };
  if (mode === 'set') {
    let value: unknown;
    try { value = JSON.parse(draft); } catch { throw new NativeConfigurationFailure('nnd_configuration_request_invalid'); }
    if (!typedValue(field, value)) throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
    operation = { op: 'set', field: field.path, value };
  }
  return { installation_id: view.installation_id, data_id: view.data_id, scope: 'user',
    expected_revision: view.source_revision!, expected_resolution_revision: view.resolution_revision!, operations: [operation] };
}
function typedValue(field: NativeEditableField, value: unknown): boolean {
  if (value === null) return true; // Native validation decides whether this field permits unset/null.
  if (field.type === 'integer') return Number.isInteger(value);
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'string') return typeof value === 'string' && value.length <= 4096;
  if (field.type === 'enum') return typeof value === 'string' && Boolean(field.enum?.includes(value));
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && item.length <= 256);
}
export async function previewNativeConfiguration(request: NativeChangeRequest, signal: AbortSignal): Promise<NativePreview> {
  const raw = await call('/preview', 'POST', signal, request);
  if (!record(raw) || raw.valid !== true || raw.application !== 'not_applied'
    || raw.expected_revision !== request.expected_revision || raw.resolution_revision !== request.expected_resolution_revision) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
  const view = parseNativeConfigurationView(raw.view);
  if (!view || view.installation_id !== request.installation_id || view.data_id !== request.data_id) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
  return { valid: true, expected_revision: request.expected_revision, resolution_revision: request.expected_resolution_revision,
    application: 'not_applied', view };
}
function receipt(raw: unknown, identity: { installation_id: string; data_id: string }, operationId: string,
  expectedRevision?: string): NativeReceipt {
  if (!record(raw) || raw.installation_id !== identity.installation_id || raw.data_id !== identity.data_id
    || raw.scope !== 'user' || raw.operation_id !== operationId || !['saved', 'unpublished', 'unknown'].includes(String(raw.persistence))
    || !(raw.persisted_revision === null || revision(raw.persisted_revision)) || !revision(raw.before_revision)
    || (expectedRevision !== undefined && raw.before_revision !== expectedRevision)
    || (raw.persistence === 'saved' && (raw.persisted_revision === null || raw.persisted_revision === 'absent'))
    || raw.application !== 'not_applied' || typeof raw.replayed !== 'boolean') throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
  return raw as unknown as NativeReceipt;
}
export async function saveNativeConfiguration(request: NativeChangeRequest, operationId: string, signal: AbortSignal): Promise<NativeReceipt> {
  if (authorityState() !== 'ready') throw new NativeConfigurationFailure('nnd_configuration_unavailable');
  return receipt(await call('/save', 'POST', signal, { ...request, operation_id: operationId }), request, operationId, request.expected_revision);
}
export async function lookupNativeConfigurationOperation(identity: { installation_id: string; data_id: string }, operationId: string,
  signal: AbortSignal): Promise<NativeReceipt | null> {
  if (!ID.test(operationId)) throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  try { return receipt(await call(`/operations/${operationId}`, 'GET', signal), identity, operationId); }
  catch (error) { if (error instanceof NativeConfigurationFailure && error.code === 'operation_not_found') return null; throw error; }
}
export function nativeRepairDocument(input: unknown): Record<string, unknown> {
  if (!record(input) || !record(input.provider)) throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  const provider = input.provider;
  if (Object.keys(input).some(key => !['workspace_root', 'provider'].includes(key))
    || typeof input.workspace_root !== 'string' || !input.workspace_root.trim() || input.workspace_root.length > 4096
    || Object.keys(provider).some(key => !['id', 'endpoint', 'model', 'trust_zone'].includes(key))
    || !['id', 'endpoint', 'model', 'trust_zone'].every(key => typeof provider[key] === 'string' && (provider[key] as string).length > 0)) {
    throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  }
  return input;
}
export async function repairNativeConfiguration(view: NativeConfigurationView, document: Record<string, unknown>, operationId: string,
  signal: AbortSignal): Promise<NativeReceipt> {
  if (authorityState() !== 'ready') throw new NativeConfigurationFailure('nnd_configuration_unavailable');
  if (view.source_state === 'present' || !REVISION.test(view.source_revision ?? '') || !ID.test(operationId)) throw new NativeConfigurationFailure('nnd_configuration_request_invalid');
  return receipt(await call('/repair', 'POST', signal, { installation_id: view.installation_id, data_id: view.data_id,
    scope: 'user', expected_revision: view.source_revision, operation_id: operationId,
    document: nativeRepairDocument(document) }), view, operationId, view.source_revision!);
}
