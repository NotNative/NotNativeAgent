// SPDX-License-Identifier: Apache-2.0
/** Read-only NNA configuration projection. NNA remains the persistence authority. */
import { runtimeFetch } from '../runtime-fetch.ts';

export type NativeValue = { present: false } | { present: true; redacted: true }
  | { present: true; value_unavailable: true } | { present: true; value: string | number | boolean | null | (string | number | boolean | null)[] };
export interface NativeConfigurationField {
  path: string;
  catalog_path: string;
  explicit: NativeValue;
  effective: NativeValue & { source?: string; source_unavailable?: boolean };
  application: 'not_applied';
}
export interface NativeConfigurationView {
  schema_version: '1.0';
  installation_id: string;
  data_id: string;
  scope: 'user';
  source_state: 'present' | 'missing' | 'invalid';
  source_revision: string | null;
  resolution_revision: string | null;
  source_revisions: { source: string; revision?: string }[];
  application: 'not_applied';
  fields: NativeConfigurationField[];
}
const LAYERS = new Set(['compiled_default', 'user', 'project', 'explicit', 'launch_override', 'session']);
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^(?:absent|[a-f0-9]{64})$/u.test(value);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown): boolean => value === null || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 4096;
function nativeValue(value: unknown): value is NativeValue {
  if (!record(value) || typeof value.present !== 'boolean') return false;
  if (!value.present) return !Object.hasOwn(value, 'value') && !Object.hasOwn(value, 'redacted')
    && !Object.hasOwn(value, 'value_unavailable');
  if (Object.hasOwn(value, 'redacted')) return value.redacted === true
    && !Object.hasOwn(value, 'value') && !Object.hasOwn(value, 'value_unavailable');
  if (Object.hasOwn(value, 'value_unavailable')) return value.value_unavailable === true
    && !Object.hasOwn(value, 'value');
  return Object.hasOwn(value, 'value') && (scalar(value.value)
    || Array.isArray(value.value) && value.value.length <= 128 && value.value.every(scalar));
}
export function parseNativeConfigurationView(value: unknown): NativeConfigurationView | null {
  if (!record(value) || value.schema_version !== '1.0' || !identity(value.installation_id)
    || !identity(value.data_id) || value.scope !== 'user'
    || !['present', 'missing', 'invalid'].includes(String(value.source_state))
    || !(value.source_revision === null || revision(value.source_revision))
    || !(value.resolution_revision === null || revision(value.resolution_revision))
    || value.application !== 'not_applied' || !Array.isArray(value.source_revisions)
    || value.source_revisions.length > 8 || !value.source_revisions.every((source: unknown) =>
      record(source) && typeof source.source === 'string' && (LAYERS.has(source.source) || source.source === 'unknown')
      && (!Object.hasOwn(source, 'revision') || revision(source.revision)))
    || !Array.isArray(value.fields) || value.fields.length > 4096) return null;
  for (const field of value.fields) {
    if (!record(field) || typeof field.path !== 'string' || field.path.length > 512
      || typeof field.catalog_path !== 'string' || field.catalog_path.length > 512
      || !nativeValue(field.explicit) || !nativeValue(field.effective)
      || field.application !== 'not_applied') return null;
    const effective = field.effective as Record<string, unknown>;
    if (effective.source !== undefined && (typeof effective.source !== 'string' || !LAYERS.has(effective.source))) return null;
    if (effective.source_unavailable !== undefined && effective.source_unavailable !== true) return null;
  }
  return value as unknown as NativeConfigurationView;
}

export async function requestNativeConfiguration(signal: AbortSignal): Promise<NativeConfigurationView> {
  const response = await runtimeFetch('/api/v1/nnd/configuration', {
    method: 'GET', signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
  });
  if (response.status === 404) throw new Error('native-configuration-unsupported');
  if (!response.ok) throw new Error('native-configuration-unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('native-configuration-unavailable');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('native-configuration-invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  const parsed = parseNativeConfigurationView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)));
  if (!parsed) throw new Error('native-configuration-invalid');
  return parsed;
}
