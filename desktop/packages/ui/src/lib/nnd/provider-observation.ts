// SPDX-License-Identifier: Apache-2.0
/** Narrow NNA provider-observation family contract (NNA a026763e, 20261007-1).
 * The census keeps thirteen manifest_provider rows for what a provider is bound
 * to: the credential binding (source, environment name, secret id, secret
 * field), the credential and capability containers, and the credential_env
 * compatibility alias, in both the providers[*] and provider spellings. None of
 * them is a secret value. NNA projects each binding through credentialManifest,
 * so the wire shape is source plus name, or source plus secret id and field, and
 * this parser refuses anything else, including an unexpected capability flag.
 * Reads are read-only: provider writes belong to the manifest transaction that
 * writes with an expected revision, so this module has no verb that changes
 * anything.
 */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/provider-observations';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(absent|[a-f0-9]{64})$/u;
const NAME = /^[A-Za-z0-9_]{1,256}$/u;
const TEXT = /^[^\u0000-\u001f]{1,256}$/u;
const ZONES: readonly string[] = ['loopback', 'private_network', 'public_network'];
const REQUEST_BYTES = 73_728;

export type NativeCredentialBinding =
  | { source: 'environment'; name: string }
  | { source: 'secret'; secret_id: string; field: string };

export interface NativeProviderEntry {
  id: string; model: string; endpoint: string; trust_zone: 'loopback' | 'private_network' | 'public_network';
  credential: NativeCredentialBinding | null; credential_env: string | null;
  capabilities: { streaming: boolean; tools: boolean; images: boolean; structured_output: boolean;
    usage: boolean; cancellation: boolean };
}

export interface NativeProviderObservationView {
  schema_version: '1.0'; installation_id: string; data_id: string; scope: 'user';
  source_state: 'absent' | 'present'; manifest_revision: string; providers: NativeProviderEntry[];
}

export class NativeProviderObservationFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code); this.name = 'NativeProviderObservationFailure'; this.code = code;
  }
}

const viewInvalid = () => new NativeProviderObservationFailure('nnd_provider_observation_projection_invalid');

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, pattern: RegExp): value is string =>
  typeof value === 'string' && pattern.test(value);

function parseBinding(value: unknown): NativeCredentialBinding | null {
  if (value === null) return null;
  if (!record(value)) throw viewInvalid();
  const keys = Object.keys(value).sort().join(',');
  if (value.source === 'environment' && keys === 'name,source' && text(value.name, NAME)) {
    return { source: 'environment', name: value.name };
  }
  if (value.source === 'secret' && keys === 'field,secret_id,source'
    && text(value.secret_id, ID) && text(value.field, NAME)) {
    return { source: 'secret', secret_id: value.secret_id, field: value.field };
  }
  throw viewInvalid();
}

function parseCapabilities(value: unknown): NativeProviderEntry['capabilities'] {
  if (!record(value)) throw viewInvalid();
  const names = ['cancellation', 'images', 'streaming', 'structured_output', 'tools', 'usage'];
  if (Object.keys(value).sort().join(',') !== names.join(',')) throw viewInvalid();
  const flags = {} as NativeProviderEntry['capabilities'];
  for (const name of names) {
    if (typeof value[name] !== 'boolean') throw viewInvalid();
    flags[name as keyof NativeProviderEntry['capabilities']] = value[name] as boolean;
  }
  return flags;
}

function parseEntry(value: unknown): NativeProviderEntry {
  if (!record(value)) throw viewInvalid();
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'capabilities,credential,credential_env,endpoint,id,model,trust_zone') throw viewInvalid();
  if (!text(value.id, ID) || !text(value.model, TEXT) || !text(value.endpoint, TEXT)) throw viewInvalid();
  if (typeof value.trust_zone !== 'string' || !ZONES.includes(value.trust_zone)) throw viewInvalid();
  if (value.credential_env !== null && !text(value.credential_env, NAME)) throw viewInvalid();
  return { id: value.id, model: value.model, endpoint: value.endpoint,
    trust_zone: value.trust_zone as NativeProviderEntry['trust_zone'],
    credential: parseBinding(value.credential), credential_env: value.credential_env as string | null,
    capabilities: parseCapabilities(value.capabilities) };
}

/** Local mirror of NNA's router whitelist, applied before the view reaches a
 * component, so a drifted response is reported rather than half-rendered. */
export function parseNativeProviderObservationView(raw: unknown): NativeProviderObservationView {
  const keys = 'data_id,installation_id,manifest_revision,providers,schema_version,scope,source_state';
  if (!record(raw) || Object.keys(raw).sort().join(',') !== keys
    || raw.schema_version !== '1.0' || !text(raw.installation_id, ID) || !text(raw.data_id, ID)
    || raw.scope !== 'user' || (raw.source_state !== 'absent' && raw.source_state !== 'present')
    || !text(raw.manifest_revision, REVISION) || !Array.isArray(raw.providers)
    || (raw.source_state === 'absent' && raw.providers.length !== 0)
    // Stricter than NNA's projector on purpose: a manifest that resolves always
    // yields at least one profile, so "present with no providers" is a transport
    // fault, and rendering it would show an empty list that reads as "nothing is
    // configured" rather than as a refusal.
    || (raw.source_state === 'present' && (raw.providers.length === 0
      || raw.manifest_revision === 'absent'))
    || (raw.source_state === 'absent' && raw.manifest_revision !== 'absent')) throw viewInvalid();
  return { schema_version: '1.0', installation_id: raw.installation_id as string,
    data_id: raw.data_id as string, scope: 'user',
    source_state: raw.source_state as 'absent' | 'present',
    manifest_revision: raw.manifest_revision as string,
    providers: raw.providers.map(parseEntry) };
}

async function call(signal: AbortSignal): Promise<NativeProviderObservationView> {
  const response = await runtimeFetch(BASE, { method: 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
  if (response.status === 404) {
    throw new NativeProviderObservationFailure('nnd_provider_observation_not_available');
  }
  if (response.status !== 200) {
    const bytes = await response.arrayBuffer();
    let message = '';
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as
        { error?: { code?: unknown } };
      if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object'
        && typeof parsed.error.code === 'string') message = parsed.error.code;
      else throw new Error('shape');
    } catch { message = 'nnd_provider_observation_unavailable'; }
    throw new NativeProviderObservationFailure(message || 'nnd_provider_observation_unavailable');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > REQUEST_BYTES) throw viewInvalid();
  return parseNativeProviderObservationView(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

export async function readNativeProviderObservation(signal: AbortSignal): Promise<NativeProviderObservationView> {
  return call(signal);
}

/** Honest sentence map for the panel; unmatched codes fall back to the code. */
export const providerObservationMessages: Record<string, string> = {
  nnd_provider_observation_unavailable: 'The provider observation is unavailable on this runtime.',
  nnd_provider_observation_projection_invalid: 'The provider view drifted from its verified grammar.',
  nnd_provider_observation_request_invalid: 'The provider observation request was malformed.',
  nnd_configuration_unavailable: 'The provider observation is not wired on this runtime.',
  integration_permission_denied: 'This account lacks the read right for provider configuration.',
  invalid_trust_zone: 'A provider declares a trust zone that does not match its endpoint; repair the manifest.',
  invalid_manifest: 'The manifest will not resolve, so no provider view can be served.',
};
