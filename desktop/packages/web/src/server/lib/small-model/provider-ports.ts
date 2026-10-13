// SPDX-License-Identifier: Apache-2.0
/** Provider catalog, harness config, and credential seams for small models. */

import { readFile } from 'node:fs/promises';
import { callHarness, harnessRequest } from '../../queue/queue-adapter-calls.ts';
import { objectOf, textOf } from './service.ts';

export interface SmallModelPorts {
  providers?: (directory: string) => Promise<unknown>;
  config?: (directory: string) => Promise<unknown>;
  readMessages?: (sessionId: string, directory: string, limit: number) => Promise<unknown[]>;
  settings?: () => Promise<Record<string, unknown>>;
  authFile?: string | ((directory: string) => string);
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

export async function credentialEvidence(
  directory: string, providers: readonly ProviderRecord[], ports: SmallModelPorts,
): Promise<CredentialEvidence> {
  const result: CredentialEvidence = {};
  for (const provider of providers) {
    // Native authority (F5 step 2): presence evidence comes from the profile's
    // credential manifest or environment reference in the mapped model record.
    // The desktop never opens a credential store; only an explicitly injected
    // legacy authFile (tests) may still contribute evidence.
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
  if (ports.authFile === undefined) return result;
  try {
    const raw = await readFile(authFile(directory, ports), { encoding: 'utf8' });
    const map = objectOf(JSON.parse(raw)) ?? {};
    for (const provider of providers) {
      const entry = objectOf(map[provider.id]);
      const key = textOf(entry?.key, 8192);
      const access = textOf(entry?.access, 8192);
      if (entry?.type === 'api' && key !== '') result[provider.id] = 'api';
      if (entry?.type === 'oauth' && access !== '') result[provider.id] = 'oauth';
    }
  } catch { /* an unreadable legacy store contributes nothing */ }
  return result;
}

export async function credentialFor(
  directory: string, providerID: string, provider: ProviderRecord, ports: SmallModelPorts,
): Promise<{ key: string; kind: 'api' | 'oauth' } | null> {
  // Native authority (F5 step 2): a secret-backed manifest can never yield a
  // raw value to the desktop, so it resolves to null (native generation is the
  // remaining F5 step). An environment reference resolves through the service
  // runtime's own environment. A legacy authFile is only opened when a test
  // explicitly injects one; the default paths never touch the filesystem.
  if (ports.authFile !== undefined) {
    try {
      const map = objectOf(JSON.parse(await readFile(authFile(directory, ports), { encoding: 'utf8' })));
      const entry = objectOf(map?.[providerID]);
      const key = textOf(entry?.key, 8192);
      const access = textOf(entry?.access, 8192);
      if (entry?.type === 'api' && key !== '') return { key, kind: 'api' };
      if (entry?.type === 'oauth' && access !== '') return { key: access, kind: 'oauth' };
    } catch { /* missing store is a normal no-login condition */ }
  }
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

export function authFile(directory: string, ports: SmallModelPorts): string {
  // Legacy seam for tests only: an explicitly injected path. The native
  // runtime has no default store — F5 removes the OpenCode auth.json read
  // from the desktop's default behavior (NNA 20261011-7 assist seam is the
  // generation authority; secret-backed profiles resolve to no raw value).
  const explicit = typeof ports.authFile === 'function' ? ports.authFile(directory)
    : typeof ports.authFile === 'string' ? ports.authFile : null;
  if (explicit === null) throw new Error('authFile is not configured');
  return explicit;
}
