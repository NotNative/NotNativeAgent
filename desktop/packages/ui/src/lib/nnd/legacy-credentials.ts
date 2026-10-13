// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA legacy provider-credential alias family contract (20261006-19).
 * The census row wraps src/provider/bootstrap.js
 * loadManagedProviderCredentials — the startup alias loader for
 * config/provider-credentials.json (the legacy NNA_PROVIDER_INITIAL_KEY
 * environment injection). This lib pins its native read: GET
 * /api/v1/nnd/configuration/legacy-provider-credentials runs that authority
 * on the SERVED process against a spare environment and projects the
 * verdict WITHOUT the value: loaded/count/reason only (sensitivity: secret).
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/legacy-provider-credentials';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const RESPONSE_BOUND = 8_192;
const REASONS = ['provider_bootstrap_file_too_large', 'provider_credentials_invalid', null];

export interface NativeLegacyProviderCredentialsReceipt {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  loaded: boolean; count: 0 | 1;
  reason: 'provider_bootstrap_file_too_large' | 'provider_credentials_invalid' | null;
}

export class NativeLegacyCredentialsFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeLegacyCredentialsFailure'; this.code = code; }
}

const viewInvalid = () => new NativeLegacyCredentialsFailure('nnd_legacy_provider_credentials_projection_invalid');
const KEYS = 'count,data_id,installation_id,loaded,reason,schema_version,scope';

/** Local mirror of the route's fail-closed projector. */
export function parseNativeLegacyProviderCredentials(raw: unknown): NativeLegacyProviderCredentialsReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const receipt = raw as Record<string, unknown>;
  if (Object.keys(receipt).sort().join(',') !== KEYS
    || receipt.schema_version !== '1.0'
    || typeof receipt.installation_id !== 'string' || !ID.test(receipt.installation_id)
    || typeof receipt.data_id !== 'string' || !ID.test(receipt.data_id)
    || receipt.scope !== 'user' || typeof receipt.loaded !== 'boolean'
    || (receipt.count !== 0 && receipt.count !== 1)
    || !REASONS.includes(receipt.reason as never)
    || (receipt.loaded === true && (receipt.count !== 1 || receipt.reason !== null))
    || (receipt.loaded === false && receipt.count !== 0)) throw viewInvalid();
  return receipt as unknown as NativeLegacyProviderCredentialsReceipt;
}

export async function readNativeLegacyProviderCredentials(signal: AbortSignal): Promise<NativeLegacyProviderCredentialsReceipt> {
  const response = await runtimeFetch(BASE, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (response.status === 404) throw new NativeLegacyCredentialsFailure('nnd_legacy_credentials_not_available');
  if (response.status !== 200) {
    const raw = await response.arrayBuffer();
    let code = 'nnd_legacy_credentials_unavailable';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as
        { error?: { code?: unknown } };
      if (parsed?.error && typeof parsed.error.code === 'string') code = parsed.error.code;
    } catch { /* keep the loopback-surface sentence */ }
    throw new NativeLegacyCredentialsFailure(code);
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > RESPONSE_BOUND) throw viewInvalid();
  return parseNativeLegacyProviderCredentials(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
}

/** Honest sentence map; unmatched codes fall back to the code. */
export const legacyCredentialsMessages: Record<string, string> = {
  nnd_legacy_credentials_unavailable: 'The legacy credential observation is unavailable on this runtime.',
  nnd_legacy_credentials_not_available: 'This runtime does not serve the legacy credential observation.',
  nnd_legacy_provider_credentials_projection_invalid: 'The legacy credential view drifted from its verified grammar.',
  integration_permission_denied: 'This account lacks the read right for the legacy credential observation.',
};
