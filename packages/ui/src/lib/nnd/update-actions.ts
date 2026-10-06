// SPDX-License-Identifier: Apache-2.0
/** NND operator client for the native update actions (20261006-12 surface).
 * The runtime used the -5 update-state observation store for the cached read;
 * this client performs the CHECK action (a forced live probe whose receipt the
 * runtime records) and, for honesty, learns the installer refusal from the
 * runtime itself: install runs the product's own installer as a child that
 * inherits the console and replaces the running implementation, so the native
 * operator surface refuses it and this console renders that refusal verbatim
 * instead of half-doing a system mutation. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/update/actions';
const RESPONSE_BYTES = 65536;
const UPDATE_VERSION = /^\d{8}-\d{1,6}$/u;
const SHA = /^[a-f0-9]{40}$/u;

export class NativeUpdateActionFailure extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'NativeUpdateActionFailure'; this.code = code; }
}
const viewInvalid = () => new NativeUpdateActionFailure('nnd_update_projection_invalid');

export interface UpdateAvailability {
  status: 'ready' | 'unavailable'; checkedAt: string; cached: false;
  currentVersion: string;
  latestVersion: string | null; latestRef: string | null; latestTag: string | null;
  latestSha: string | null; available: boolean; errorCode: string | null;
}
export interface UpdateCheckReceipt {
  schemaVersion: '1.0'; installationId: string; dataId: string; scope: 'user';
  action: 'check'; application: 'update_check_recorded'; operationId: string;
  availability: UpdateAvailability;
}
export type UpdateActionOutcome = { check: UpdateCheckReceipt; install: 'refused' };

const bounded = (value: unknown, max = 256) => typeof value === 'string' && value.length >= 1
  && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);

/** The availability grammar pinned one field at a time; drift is refused. */
function parseAvailability(raw: unknown, position: number): UpdateAvailability {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const row = raw as Record<string, unknown>;
  const legal = ['status', 'checked_at', 'cached', 'current_version', 'latest_version',
    'latest_ref', 'latest_tag', 'latest_sha', 'available', 'error_code'];
  if (Object.keys(row).length !== 10 || legal.some(key => !(key in row))) {
    throw viewInvalid();
  }
  if ((row.status !== 'ready' && row.status !== 'unavailable')
    || row.cached !== false || (row.available !== true && row.available !== false)
    || typeof row.checked_at !== 'string' || Number.isNaN(Date.parse(row.checked_at))) {
    throw viewInvalid();
  }
  const stamp = new Date(row.checked_at);
  if (!Number.isSafeInteger(stamp.getTime()) || stamp.getTime() <= 0) throw viewInvalid();
  for (const key of ['current_version', 'latest_version', 'latest_ref', 'latest_tag', 'latest_sha', 'error_code']) {
    if (row[key] !== null && !bounded(row[key], 128)) throw viewInvalid();
  }
  if (!UPDATE_VERSION.test(row.current_version as string)) throw viewInvalid();
  if (row.latest_version !== null && !/^(?:v)?\d{8}-\d{1,6}$/u.test(row.latest_version as string)) {
    throw viewInvalid();
  }
  if (row.latest_sha !== null && !SHA.test(row.latest_sha as string)) throw viewInvalid();
  if (row.error_code !== null && !/^[a-z][a-z0-9_]{0,63}$/u.test(row.error_code as string)) {
    throw viewInvalid();
  }
  if (position !== 0) throw viewInvalid();
  if (row.status === 'ready' && (row.latest_version === null || row.latest_sha === null
    || row.error_code !== null)) throw viewInvalid();
  if (row.status === 'unavailable' && row.error_code === null) throw viewInvalid();
  return { status: row.status, checkedAt: row.checked_at, cached: false,
    currentVersion: row.current_version as string,
    latestVersion: row.latest_version as string | null, latestRef: row.latest_ref as string | null,
    latestTag: row.latest_tag as string | null, latestSha: row.latest_sha as string | null,
    available: row.available as boolean, errorCode: row.error_code as string | null };
}

export function parseCheckReceipt(raw: unknown): UpdateCheckReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const row = raw as Record<string, unknown>;
  const legal = ['schema_version', 'installation_id', 'data_id', 'scope', 'action',
    'application', 'operation_id', 'availability'];
  if (Object.keys(row).length !== 8 || legal.some(key => !(key in row))) throw viewInvalid();
  if (row.schema_version !== '1.0' || row.scope !== 'user' || row.action !== 'check'
    || row.application !== 'update_check_recorded' || typeof row.operation_id !== 'string'
    || !/^[0-9a-f-]{36}$/u.test(row.operation_id)) throw viewInvalid();
  if (!bounded(row.installation_id, 128) || !bounded(row.data_id, 128)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.installation_id as string)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.data_id as string)) throw viewInvalid();
  return { schemaVersion: '1.0', installationId: row.installation_id as string,
    dataId: row.data_id as string, scope: 'user', action: 'check',
    application: 'update_check_recorded', operationId: row.operation_id as string,
    availability: parseAvailability(row.availability, 0) };
}

/** One envelope over the action fetches: byte-capped, typed status mapping. */
async function call(path: string, body: unknown, signal: AbortSignal, status: number): Promise<unknown> {
  let response: Response;
  try {
    response = await runtimeFetch(`${BASE}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new NativeUpdateActionFailure('nnd_update_action_unavailable');
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > RESPONSE_BYTES) throw viewInvalid();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw viewInvalid(); }
  if (response.status === status) return parsed;
  const code = (parsed as { error?: { code?: string } } | null)?.error?.code;
  throw new NativeUpdateActionFailure(response.status === 404
    ? 'nnd_update_action_not_found'
    : typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code)
      ? code : 'nnd_update_action_unavailable');
}

export async function runUpdateCheck(signal: AbortSignal): Promise<UpdateCheckReceipt> {
  return parseCheckReceipt(await call('/check', {}, signal, 200));
}

/** The install action is wired to the surface to prove the refusal honestly. */
export async function attemptInstallForReceipt(signal: AbortSignal): Promise<'refused'> {
  try { await call('/install', {}, signal, 200); }
  catch (failure) {
    if (failure instanceof NativeUpdateActionFailure && failure.code === 'nnd_update_install_unsupported') {
      return 'refused';
    }
    throw failure;
  }
  throw viewInvalid();
}

export function updateActionErrorText(code: string): string {
  const sentences: Record<string, string> = {
    nnd_update_install_unsupported: 'The installer is refused on this surface: it runs the product\'s own',
    nnd_update_projection_invalid: 'The native update action surfaced a drifted receipt.',
    nnd_configuration_unavailable: 'The native update actions are unavailable right now.',
    integration_permission_denied: 'The operator principal lacks nnd.update.manage.',
  };
  return sentences[code]
    ?? (code === 'nnd_update_action_not_found' ? 'The native update action surface is absent.'
      : code === 'nnd_update_action_unavailable'
        ? 'The native update action could not be completed.'
        : 'The update action could not be completed natively.');
}
