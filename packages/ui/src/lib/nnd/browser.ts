// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA managed-browser family contract (20261006-16/-17). The census
 * browser_action rows wrap the webbrowse CLI authority (playwrightStatus):
 * this lib pins its native read (GET status — presence, version, browser
 * path, honest refusal reason) and its verify action (POST — the same
 * authority WITH the launch probe). The receipt grammar is the one honest
 * projection: available:true means version + browser_path strings and a
 * null reason; available:false means null version/browser_path with reason
 * from {not_installed, version_mismatch, validation_failed}. Verify changes
 * nothing on disk, so both verbs read.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/browser';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:[-+].+)?$/u;
const REASONS = ['not_installed', 'version_mismatch', 'validation_failed'];
const REQUEST_BYTES = 65_536;

export interface NativeBrowserStatus {
  available: true; version: string; browser: 'chromium'; browser_path: string;
  root: string; reason: null;
}
export interface NativeBrowserRefusal {
  available: false; version: null; browser: 'chromium'; browser_path: null;
  root: string; reason: 'not_installed' | 'version_mismatch' | 'validation_failed';
}
export type NativeBrowserObservation = NativeBrowserStatus | NativeBrowserRefusal;
export interface NativeBrowserReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  action: 'status' | 'verify'; application: 'not_applied'; operation_id: string;
  status: NativeBrowserObservation;
}

export class NativeBrowserFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeBrowserFailure'; this.code = code; }
}

const viewInvalid = () => new NativeBrowserFailure('nnd_browser_projection_invalid');

/** Local mirror of NNA's normalizer, exactly the router's grammar. */
export function parseNativeBrowserReceipt(raw: unknown, action: 'status' | 'verify'): NativeBrowserReceipt {
  const keys = 'action,application,data_id,installation_id,operation_id,schema_version,scope,status';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join(',') !== keys
    || (raw as Record<string, unknown>).schema_version !== '1.0'
    || typeof (raw as Record<string, unknown>).installation_id !== 'string'
    || !ID.test((raw as Record<string, unknown>).installation_id as string)
    || typeof (raw as Record<string, unknown>).data_id !== 'string'
    || !ID.test((raw as Record<string, unknown>).data_id as string)
    || (raw as Record<string, unknown>).scope !== 'user'
    || (raw as Record<string, unknown>).action !== action
    || (raw as Record<string, unknown>).application !== 'not_applied'
    || typeof (raw as Record<string, unknown>).operation_id !== 'string'
    || !ID.test((raw as Record<string, unknown>).operation_id as string)) throw viewInvalid();
  return { ...(raw as Omit<NativeBrowserReceipt, 'status'>), status: parseStatus((raw as Record<string, unknown>).status) };
}

function parseStatus(raw: unknown): NativeBrowserObservation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as Record<string, unknown>).browser !== 'chromium'
    || typeof (raw as Record<string, unknown>).root !== 'string'
    || ((raw as Record<string, unknown>).root as string).length === 0) throw viewInvalid();
  if ((raw as Record<string, unknown>).available === true) {
    if (Object.keys(raw).sort().join(',') !== 'available,browser,browser_path,reason,root,version'
      || typeof (raw as Record<string, unknown>).version !== 'string'
      || !VERSION.test((raw as Record<string, unknown>).version as string)
      || typeof (raw as Record<string, unknown>).browser_path !== 'string'
      || ((raw as Record<string, unknown>).browser_path as string).length === 0
      || (raw as Record<string, unknown>).reason !== null) throw viewInvalid();
    return raw as unknown as NativeBrowserStatus;
  }
  if ((raw as Record<string, unknown>).available !== false
    || Object.keys(raw).sort().join(',') !== 'available,browser,browser_path,reason,root,version'
    || (raw as Record<string, unknown>).version !== null
    || (raw as Record<string, unknown>).browser_path !== null
    || !REASONS.includes((raw as Record<string, unknown>).reason as never)) throw viewInvalid();
  return raw as unknown as NativeBrowserRefusal;
}

async function call(path: string, method: 'GET' | 'POST', body: unknown,
  signal: AbortSignal): Promise<Response> {
  return runtimeFetch(BASE + path, { method,
    signal: AbortSignal.any([signal, AbortSignal.timeout(method === 'POST' ? 30_000 : 25_000)]),
    ...(method === 'GET' ? {} : { headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}) }) });
}

async function receipt(action: 'status' | 'verify', signal: AbortSignal) {
  const response = await call(action === 'status' ? '' : '/actions/verify',
    action === 'status' ? 'GET' : 'POST', {}, signal);
  if (response.status === 404) throw new NativeBrowserFailure('nnd_browser_action_not_found');
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let code = 'nnd_browser_action_unavailable';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed?.error && typeof parsed.error.code === 'string') code = parsed.error.code;
    } catch { /* keep the loopback-surface sentence */ }
    throw new NativeBrowserFailure(code);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > REQUEST_BYTES) throw viewInvalid();
  return parseNativeBrowserReceipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), action);
}

export async function readNativeBrowserStatus(signal: AbortSignal): Promise<NativeBrowserReceipt> {
  return receipt('status', signal);
}

export async function verifyNativeBrowser(signal: AbortSignal): Promise<NativeBrowserReceipt> {
  return receipt('verify', signal);
}

/** Honest sentence map; unmatched codes fall back to the code. */
export const browserMessages: Record<string, string> = {
  nnd_browser_action_unavailable: 'The managed browser observation is unavailable on this runtime.',
  nnd_browser_action_not_found: 'This runtime does not serve the managed browser observation.',
  nnd_browser_projection_invalid: 'The managed browser view drifted from its verified grammar.',
  integration_permission_denied: 'This account lacks the read right for the managed browser observation.',
  not_installed: 'The managed Playwright Chromium is not installed; rerun the NNA installer to add it.',
  version_mismatch: 'The managed Playwright version does not match this NNA release; rerun the NNA installer.',
  validation_failed: 'The installed Chromium exists but failed its live validation; watch for a broken upgrade or reinstall.',
};
