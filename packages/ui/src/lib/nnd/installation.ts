// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA installation-identity family contract (20261006-16).
 * The census classifies the six install.json descriptor rows as
 * generated_state: installer-written, service-admitted, never operator
 * editable. The read re-verifies the descriptor through the admission
 * authority and fails closed when the disk no longer supports the admission
 * (nnd_install_* 503s surface verbatim; a projected value the router cannot
 * accept would be the 500 nnd_installation_projection_invalid). There is no
 * secret in this family, so reads return values.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/installation';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const PRODUCT = 'NotNativeAgent';
const VERSION = /^\d{8}-[1-9]\d{0,5}$/u;
const PATH = /^[^\u0000-\u001f]{1,4096}$/u;
const REQUEST_BYTES = 65_536;

export interface NativeInstallationView {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  product: 'NotNativeAgent'; version: string;
  install_root: string; data_root: string; node: string; node_major: number;
}

export class NativeInstallationFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeInstallationFailure'; this.code = code; }
}

const viewInvalid = () => new NativeInstallationFailure('nnd_installation_projection_invalid');

/** Local mirror of NNA's projector: the router's whitelist, applied before
 * the view reaches any component. */
export function parseNativeInstallationView(raw: unknown): NativeInstallationView {
  const keys = 'data_id,data_root,install_root,installation_id,node,node_major,product,schema_version,scope,version';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).sort().join(',') !== keys
    || (raw as Record<string, unknown>).schema_version !== '1.0'
    || typeof (raw as Record<string, unknown>).installation_id !== 'string'
    || !ID.test((raw as Record<string, unknown>).installation_id as string)
    || typeof (raw as Record<string, unknown>).data_id !== 'string'
    || !ID.test((raw as Record<string, unknown>).data_id as string)
    || (raw as Record<string, unknown>).scope !== 'user'
    || (raw as Record<string, unknown>).product !== PRODUCT
    || typeof (raw as Record<string, unknown>).version !== 'string'
    || !VERSION.test((raw as Record<string, unknown>).version as string)
    || typeof (raw as Record<string, unknown>).install_root !== 'string'
    || !PATH.test((raw as Record<string, unknown>).install_root as string)
    || typeof (raw as Record<string, unknown>).data_root !== 'string'
    || !PATH.test((raw as Record<string, unknown>).data_root as string)
    || typeof (raw as Record<string, unknown>).node !== 'string'
    || !PATH.test((raw as Record<string, unknown>).node as string)
    || typeof (raw as Record<string, unknown>).node_major !== 'number'
    || !Number.isSafeInteger((raw as Record<string, unknown>).node_major as number)
    || ((raw as Record<string, unknown>).node_major as number) < 24
    || ((raw as Record<string, unknown>).node_major as number) > 100) throw viewInvalid();
  return raw as NativeInstallationView;
}

async function call(signal: AbortSignal): Promise<NativeInstallationView> {
  const response = await runtimeFetch(BASE, { method: 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
  if (response.status === 404) throw new NativeInstallationFailure('nnd_installation_not_available');
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let message = '';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object'
        && typeof parsed.error.code === 'string') message = parsed.error.code;
      else throw new Error('shape');
    } catch { message = 'nnd_installation_unavailable'; }
    throw new NativeInstallationFailure(message || 'nnd_installation_unavailable');
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > REQUEST_BYTES) throw viewInvalid();
  return parseNativeInstallationView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
}

export async function readNativeInstallation(signal: AbortSignal): Promise<NativeInstallationView> {
  return call(signal);
}

/** Honest sentence map for the panel; unmatched codes fall back to the code. */
export const installationMessages: Record<string, string> = {
  nnd_installation_unavailable: 'The installation observation is unavailable on this runtime.',
  nnd_installation_projection_invalid: 'The installation view drifted from its verified grammar.',
  nnd_install_descriptor_unavailable: 'The installation descriptor could not be read; repair the installation.',
  nnd_install_descriptor_invalid: 'The installation descriptor is invalid; repair the installation.',
  nnd_install_runtime_unavailable: 'The recorded Node runtime could not be verified; repair the installation.',
  integration_permission_denied: 'This account lacks the read right for the installation descriptor.',
};
