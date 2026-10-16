// SPDX-License-Identifier: Apache-2.0
/** Typed client for the native environment observation at /v1/nnd/configuration/environment.
 * Why: the settings GUI must show the service process's actual environment with credential
 * entries withheld, exactly as the native read-only projection serves it.
 * Invariant: the parser whitelists the seven observed census names; credential rows never
 * carry a value; absent rows carry value null; read-only — there is nothing to save here,
 * the environment changes in the Windows shell and reaches the service at its restart.
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const API_BASE = '/api/v1/nnd/configuration/environment';
const NAMES = ['NNA_HOME', 'NNA_PROVIDER_ENDPOINT', 'NNA_MODEL', 'NNA_REDUCED_MOTION', 'NO_COLOR',
  'NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD'];
const SECRETS = new Set(['NNA_TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD']);
const CODE = /^[a-z0-9_]{1,64}$/u;
// Read-only observation: one public value is refused above 16,384 UTF-8 bytes and the
// longest JSON escaping multiplies by 6 (98,304 per value, five public values plus
// overhead), so the bound mirrors the native derivation (see nnd-environment-route.js).
const BOUNDS = 524288;

export type NativeEnvironmentEntry = { name: string; secret: boolean; present: boolean; value: string | null };
export type NativeEnvironmentView = Record<string, unknown> & {
  schema_version: string; installation_id: string; data_id: string; scope: string;
  observation_digest: string; observed: NativeEnvironmentEntry[]; environment_scope: string;
};
export type NativeEnvironmentCatalog = Record<string, unknown> & { fields: Array<{
  path: string; classification: string; application: string;
  editability: { available: boolean; scope: string; reason: string } }> };

export class NativeEnvironmentFailure extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail?: string) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code;
    this.detail = detail ?? ''; this.name = 'NativeEnvironmentFailure'; }
}

function strictObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
  return value as Record<string, unknown>;
}

/** Rebuild the native environment observation exactly as served; unknown keys are dropped. */export function parseNativeEnvironmentView(raw: unknown): NativeEnvironmentView {
  const view = strictObject(raw);
  const outcome: NativeEnvironmentView = {
    schema_version: view.schema_version as string, installation_id: view.installation_id as string,
    data_id: view.data_id as string, scope: view.scope as string,
    observation_digest: view.observation_digest as string, observed: [], environment_scope: view.environment_scope as string,
  };
  if (outcome.schema_version !== '1.0' || typeof outcome.installation_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(outcome.installation_id) || typeof outcome.data_id !== 'string'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(outcome.data_id) || outcome.scope !== 'user'
    || !/^[a-f0-9]{64}$/u.test(String(outcome.observation_digest))
    || outcome.environment_scope !== 'service_process' || !Array.isArray(view.observed)
    || (view.observed as unknown[]).length !== NAMES.length) {
    throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
  }
  const seen = new Set<string>();
  outcome.observed = (view.observed as unknown[]).map((item) => {
    const entry = strictObject(item);
    const name = entry.name;
    const present = entry.present;
    const secret = entry.secret;
    if (typeof name !== 'string' || !NAMES.includes(name) || (present !== true && present !== false)
      || (secret !== true && secret !== false)) throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
    if (present === false && entry.value !== null) throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
    if (SECRETS.has(name)) {
      if (secret !== true || entry.value !== null) {
        throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
      }
    } else if (present === true && typeof entry.value !== 'string') {
      throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
    }
    seen.add(name);
    const value = SECRETS.has(name) || present === false ? null : entry.value as string;
    return { name, secret: secret as boolean, present: present as boolean, value };
  });
  if (seen.size !== NAMES.length || outcome.observed.some((entry, at) => entry.name !== NAMES[at])) {
    throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
  }
  return outcome;
}

/** Rebuild the catalog: one read-only field per observed census name. */
export function parseNativeEnvironmentCatalog(raw: unknown): NativeEnvironmentCatalog {
  const catalog = strictObject(raw);
  const fields = catalog.fields;
  if (catalog.schema_version !== '1.0' || catalog.source !== 'environment' || catalog.scope !== 'user'
    || !Array.isArray(fields) || fields.length !== NAMES.length) {
    throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
  }
  const seen = new Set<string>();
  const rebuilt = (fields as unknown[]).map((item) => {
    const field = strictObject(item);
    const path = field.path;
    const classification = field.classification;
    if (typeof path !== 'string' || !NAMES.includes(path)
      || classification !== (SECRETS.has(path) ? 'operator_credential' : 'operator_setting')
      || field.application !== 'restart_service') {
      throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
    }
    const editability = strictObject(field.editability);
    if (editability.available !== false || editability.scope !== 'user'
      || editability.reason !== 'process_environment') {
      throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
    }
    seen.add(path);
    return { path, classification: classification as string, application: 'restart_service' as const,
      editability: { available: false, scope: 'user', reason: 'process_environment' } };
  });
  if (seen.size !== NAMES.length || rebuilt.some((field, at) => field.path !== NAMES[at])) {
    throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
  }
  return { schema_version: '1.0', source: 'environment', scope: 'user', fields: rebuilt };
}

/** Read the live observation. */
export async function readNativeEnvironment(signal: AbortSignal): Promise<NativeEnvironmentView> {
  return parseNativeEnvironmentView(await call('', signal));
}

/** Read the catalog (read-only editability statements). */
export async function readNativeEnvironmentCatalog(signal: AbortSignal): Promise<NativeEnvironmentCatalog> {
  return parseNativeEnvironmentCatalog(await call('/catalog', signal));
}

async function call(path: string, signal: AbortSignal): Promise<unknown> {
  if (authorityState() !== 'ready') throw new NativeEnvironmentFailure('nnd_environment_unavailable');
  const response = await runtimeFetch(API_BASE + path, { method: 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  const payload = await boundedJson(response, BOUNDS);
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).error : null;
    const code = error && typeof error === 'object' && !Array.isArray(error)
      && typeof (error as Record<string, unknown>).code === 'string'
      && CODE.test(String((error as Record<string, unknown>).code))
      ? String((error as Record<string, unknown>).code)
      : response.status === 404 ? 'nnd_environment_unsupported' : 'nnd_environment_unavailable';
    throw new NativeEnvironmentFailure(code);
  }
  return payload;
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeEnvironmentFailure('nnd_environment_unavailable');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > bounds) { void reader.cancel().catch(() => undefined); throw new NativeEnvironmentFailure('nnd_environment_request_invalid'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new NativeEnvironmentFailure('nnd_environment_request_invalid');
  }
}

/** Every code the native environment surface can return that needs a specific sentence. */
export const environmentMessages: Record<string, string> = {
  nnd_environment_unavailable: 'The environment observation is unreachable right now.',
  nnd_environment_unsupported: 'This native service does not serve the environment observation.',
  nnd_environment_request_invalid: 'The environment observation could not be read in the expected shape.',
  nnd_environment_value_too_large: 'An observed environment value exceeded the projection bound.',
  nnd_configuration_unavailable: 'The environment observation is unavailable on this native service.',
};

/** Which of the observed census names are credential rows (values are always withheld). */
export function environmentEntryIsSecret(name: string): boolean {
  return SECRETS.has(name);
}
