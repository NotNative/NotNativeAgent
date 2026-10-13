// SPDX-License-Identifier: Apache-2.0
/** Provider catalog, harness config, and credential seams for small models. */

import { callHarness, harnessRequest } from '../../queue/queue-adapter-calls.ts';
import { objectOf, textOf } from './service.ts';

export interface SmallModelPorts {
  providers?: (directory: string) => Promise<unknown>;
  config?: (directory: string) => Promise<unknown>;
  readMessages?: (sessionId: string, directory: string, limit: number) => Promise<unknown[]>;
  settings?: () => Promise<Record<string, unknown>>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ProviderRecord {
  id: string;
  name?: string;
  options?: unknown;
  models?: Record<string, unknown>;
}

export type CredentialEvidence = Record<string, 'api' | 'oauth'>;

export async function providerList(ports: SmallModelPorts, directory: string): Promise<ProviderRecord[] | null> {
  try {
    const values = ports.providers !== undefined
      ? ports.providers(directory)
      // Native authority (F5 step 2): the inventory is NNA's public provider
      // profile roster — one profile maps to exactly one model with endpoint,
      // limits, and a credential *manifest* (presence only, never a value).
      : callHarness(harnessRequest('/v1/provider-profiles', directory, {
        method: 'GET', signal: AbortSignal.timeout(5000),
      })).then((value) => value.ok ? value.json().catch(() => null) : null);
    const raw = await Promise.resolve(values);
    const list = Array.isArray(raw) ? raw
      : Array.isArray(objectOf(raw)?.profiles) ? objectOf(raw)!.profiles as unknown[] : null;
    if (list === null) return null;
    return list.flatMap((entry) => shapeProviderRecord(objectOf(entry))).filter((value) => value !== null);
  } catch {
    return null;
  }
}

function shapeProviderRecord(entry: Record<string, unknown> | null): ProviderRecord[] {
  // Injected (legacy-shaped) records keep their own shape; only native NNA
  // public profiles — one profile_id/model pair — need mapping.
  if (entry !== null && typeof entry.id === 'string' && entry.id !== '' && objectOf(entry.models) !== null) {
    return [entry as unknown as ProviderRecord];
  }
  if (entry === null || typeof entry.profile_id !== 'string' || entry.profile_id === ''
    || typeof entry.model !== 'string' || entry.model === '') return [];
  const models: Record<string, unknown> = { [entry.model]: {
    id: entry.model,
    api: typeof entry.endpoint === 'string' ? { url: entry.endpoint } : undefined,
    limit: {
      context: typeof entry.context_limit_bytes === 'number' ? entry.context_limit_bytes : undefined,
      output: typeof entry.output_limit_tokens === 'number' ? entry.output_limit_tokens : undefined,
    },
    credential_manifest: entry.credential ?? null,
    credential_env: typeof entry.credential_env === 'string' ? entry.credential_env : null,
    active: entry.active === true,
  } };
  return [{ id: entry.profile_id, name: typeof entry.display_name === 'string' ? entry.display_name : undefined, models }];
}

export async function readConfig(ports: SmallModelPorts, directory: string): Promise<unknown> {
  try {
    if (ports.config !== undefined) return await ports.config(directory);
    const response = await callHarness(harnessRequest('/config', directory, {
      method: 'GET', signal: AbortSignal.timeout(5000),
    }));
    return response.ok ? await response.json().catch(() => null) : null;
  } catch {
    return null;
  }
}

export function credentialEvidence(
  directory: string, providers: readonly ProviderRecord[], ports: SmallModelPorts,
): CredentialEvidence {
  void directory; void ports;
  const result: CredentialEvidence = {};
  for (const provider of providers) {
    // Native authority (F5 step 2): presence evidence comes from the profile's
    // credential manifest or environment reference in the mapped model record.
    // The desktop never opens a credential store — the OpenCode auth.json
    // read was deleted, so no path here touches a filesystem credential file.
    for (const model of Object.values(objectOf(provider.models) ?? {})) {
      const shape = objectOf(model);
      const manifest = shape?.credential_manifest;
      const env = typeof shape?.credential_env === 'string' ? shape.credential_env : null;
      const manifestApi = manifest !== null && manifest !== undefined && objectOf(manifest) !== null;
      if (manifestApi || (env !== null && process.env[env] !== undefined && process.env[env] !== '')) {
        result[provider.id] = 'api';
        break;
      }
    }
    if (result[provider.id] === undefined && configuredApiKeyShape(provider) !== null) result[provider.id] = 'api';
  }
  return result;
}

export function credentialFor(
  directory: string, providerID: string, provider: ProviderRecord, ports: SmallModelPorts,
): { key: string; kind: 'api' | 'oauth' } | null {
  void directory; void providerID; void ports;
  // Native authority (F5 step 2): a secret-backed manifest can never yield a
  // raw value to the desktop, so it resolves to null (native generation is the
  // remaining F5 step). An environment reference resolves through the service
  // runtime's own environment. No default path touches the filesystem.
  for (const model of Object.values(objectOf(provider.models) ?? {})) {
    const shape = objectOf(model);
    if (shape?.credential_manifest !== null && shape?.credential_manifest !== undefined) continue;
    const env = typeof shape?.credential_env === 'string' ? shape.credential_env : null;
    if (env !== null) {
      const value = process.env[env];
      if (typeof value === 'string' && value !== '') return { key: value, kind: 'api' };
    }
  }
  const configured = configuredApiKeyShape(provider);
  return configured === null ? null : { key: configured, kind: 'api' };
}

export function configuredApiKeyShape(provider: ProviderRecord): string | null {
  const options = objectOf(provider.options);
  const apiKey = textOf(options?.apiKey, 8192);
  if (apiKey === '' || apiKey === 'public') return null;
  const env = /^\{env:([^}]+)\}$/u.exec(apiKey);
  if (env !== null) {
    const value = process.env[env[1]!];
    return typeof value === 'string' && value !== '' ? value : null;
  }
  return apiKey;
}
