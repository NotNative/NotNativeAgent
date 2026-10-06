// SPDX-License-Identifier: Apache-2.0
/** Typed client for the native update-state observation at /v1/nnd/configuration/update-state.
 * Why: the settings GUI must show the update worker's recorded check exactly as the
 * native read-only projection serves it, rather than repeating a private web request.
 * Invariant: read-only; any content the native validator refuses (absent, corrupt, or
 * foreign-shaped store) projects as state 'absent' — "no recorded check is known to be
 * valid" — never a guessed shape. The parser mirrors the native store grammar and
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { authorityState } from '../../sync/authority-sync.ts';

const API_BASE = '/v1/nnd/configuration/update-state';
const CODE = /^[a-z0-9_]{1,64}$/u;
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PATHS = ['format', 'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag',
  'latest_sha', 'error_code'];
// Read-only observation over a small fixed-composition store.
const BOUNDS = 65536;

export type NativeUpdateStateView = Record<string, unknown> & {
  schema_version: string; installation_id: string; data_id: string; scope: string; state: string;
  format?: number; checked_at?: string | null; status?: string | null; latest_version?: string | null;
  latest_ref?: string | null; latest_tag?: string | null; latest_sha?: string | null;
  error_code?: string | null;
};

export class NativeUpdateStateFailure extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail?: string) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code;
    this.detail = detail ?? ''; this.name = 'NativeUpdateStateFailure'; }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  return value as Record<string, unknown>;
}

// Store-grammar patterns mirrored from nnd-update-state-route.js (store parity).
const VERSION_PATTERN = /^(?:v)?\d{8}-\d{1,15}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function brief(value: unknown, pattern?: RegExp): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || (pattern ? !pattern.test(value) : value.length > 256)) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  return value;
}

/** Store-grammar parity with the native validator (nnd-update-state-route.js). */
function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= 0) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  return value;
}

/** Rebuild the native update-state observation exactly as served; unknown keys are dropped. */
export function parseNativeUpdateStateView(raw: unknown): NativeUpdateStateView {
  const view = object(raw);
  const outcome: NativeUpdateStateView = {
    schema_version: view.schema_version as string, installation_id: view.installation_id as string,
    data_id: view.data_id as string, scope: view.scope as string, state: view.state as string,
  };
  if (outcome.schema_version !== '1.0' || typeof outcome.installation_id !== 'string'
    || !ID.test(outcome.installation_id) || typeof outcome.data_id !== 'string'
    || !ID.test(outcome.data_id) || outcome.scope !== 'user') {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  if (outcome.state === 'absent') return outcome;
  if (outcome.state !== 'recorded') throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  if (view.format !== 1 || view.status !== 'ready' && view.status !== 'unavailable') {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  const status = view.status as string;
  const latestVersion = brief(view.latest_version, VERSION_PATTERN);
  const latestSha = brief(view.latest_sha, SHA_PATTERN);
  if (status === 'ready' && (latestVersion === null || latestSha === null)) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  if (typeof view.checked_at !== 'string') throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  const checkedAt = timestamp(view.checked_at);
  const rebuilt = {
    schema_version: '1.0' as const, installation_id: outcome.installation_id, data_id: outcome.data_id,
    scope: 'user' as const, state: 'recorded' as const, format: 1 as const, status,
    checked_at: checkedAt as string, latest_version: latestVersion,
    latest_ref: brief(view.latest_ref), latest_tag: brief(view.latest_tag),
    latest_sha: latestSha, error_code: brief(view.error_code),
  };
  // The recorded projection carries exactly the census fields (every census key present,
  // unknown future fields dropped like every sibling family's parser, a missing or
  // renamed field failing closed). Servers order their projection; this client fixes
  // its own stable output order. The store-grammar parity covers the unavailable error
  // code too: whatever the store holds (a code or null) is served as stored.
  const expected = ['installation_id', 'data_id', 'scope', 'schema_version', 'state', 'format',
    'checked_at', 'status', 'latest_version', 'latest_ref', 'latest_tag', 'latest_sha', 'error_code'];
  const expectedKeys = new Set(expected);
  const keys = Object.keys(view);
  const known = keys.filter((key) => expectedKeys.has(key));
  if (known.length !== expected.length) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  return rebuilt as NativeUpdateStateView;
}

export type NativeUpdateStateCatalog = { schema_version: string; source: string; scope: string;
  fields: Array<{ path: string; classification: string; application: string;
    editability: { available: boolean; scope: string; reason: string } }> };

/** Rebuild the catalog: eight read-only census fields. */
export function parseNativeUpdateStateCatalog(raw: unknown): NativeUpdateStateCatalog {
  const catalog = object(raw);
  if (catalog.schema_version !== '1.0' || catalog.source !== 'update_state' || catalog.scope !== 'user'
    || !Array.isArray(catalog.fields) || catalog.fields.length !== PATHS.length) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  const rebuilt = (catalog.fields as unknown[]).map((item) => {
    const field = object(item);
    if (typeof field.path !== 'string' || !PATHS.includes(field.path)
      || field.classification !== 'generated_state' || field.application !== 'next_update_check') {
      throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
    }
    const editability = object(field.editability);
    if (editability.available !== false || editability.scope !== 'user'
      || editability.reason !== 'generated_state') {
      throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
    }
    return { path: field.path, classification: 'generated_state', application: 'next_update_check',
      editability: { available: false, scope: 'user', reason: 'generated_state' } };
  });
  if (rebuilt.some((field, at) => field.path !== PATHS[at])) {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
  return { schema_version: '1.0', source: 'update_state', scope: 'user', fields: rebuilt };
}

async function call(path: string, signal: AbortSignal): Promise<unknown> {
  if (authorityState() !== 'ready') throw new NativeUpdateStateFailure('nnd_update_state_unavailable');
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
      : response.status === 404 ? 'nnd_update_state_unsupported' : 'nnd_update_state_unavailable';
    throw new NativeUpdateStateFailure(code);
  }
  return payload;
}

async function boundedJson(response: Response, bounds: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new NativeUpdateStateFailure('nnd_update_state_unavailable');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > bounds) { void reader.cancel().catch(() => undefined);
      throw new NativeUpdateStateFailure('nnd_update_state_request_invalid'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new NativeUpdateStateFailure('nnd_update_state_request_invalid');
  }
}

/** Read the live observation. */
export async function readNativeUpdateState(signal: AbortSignal): Promise<NativeUpdateStateView> {
  return parseNativeUpdateStateView(await call('', signal));
}

/** Read the catalog (read-only editability statements). */
export async function readNativeUpdateStateCatalog(signal: AbortSignal): Promise<NativeUpdateStateCatalog> {
  return parseNativeUpdateStateCatalog(await call('/catalog', signal));
}

/** Every code the native update-state surface can return that needs a specific sentence. */
export const updateStateMessages: Record<string, string> = {
  nnd_update_state_unavailable: 'The update state observation is unreachable right now.',
  nnd_update_state_unsupported: 'This native service does not serve the update state observation.',
  nnd_update_state_request_invalid: 'The update state observation could not be read in the expected shape.',
  nnd_configuration_unavailable: 'The update state observation is unavailable on this native service.',
};
