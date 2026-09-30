// SPDX-License-Identifier: Apache-2.0
/** Provider catalog, harness config, and credential seams for small models. */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
      : callHarness(harnessRequest('/config/providers', directory, {
        method: 'GET', signal: AbortSignal.timeout(5000),
      })).then((value) => value.ok ? value.json().catch(() => null) : null);
    const raw = await Promise.resolve(values);
    const shape = objectOf(raw);
    const list = Array.isArray(raw) ? raw
      : Array.isArray(shape?.providers) ? shape!.providers : null;
    if (list === null) return null;
    return list.flatMap((entry) => {
      const shape = objectOf(entry) as ProviderRecord | null;
      return shape === null || typeof shape.id !== 'string' || shape.id === '' || !objectOf(shape.models) ? [] : [shape];
    });
  } catch {
    return null;
  }
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
  try {
    const raw = await readFile(authFile(directory, ports), { encoding: 'utf8' });
    const map = objectOf(JSON.parse(raw)) ?? {};
    const result: CredentialEvidence = {};
    for (const provider of providers) {
      const entry = objectOf(map[provider.id]);
      const key = textOf(entry?.key, 8192);
      const access = textOf(entry?.access, 8192);
      if (entry?.type === 'api' && key !== '') result[provider.id] = 'api';
      if (entry?.type === 'oauth' && access !== '') result[provider.id] = 'oauth';
      if (configuredApiKeyShape(provider) !== null) result[provider.id] ??= 'api';
    }
    return result;
  } catch {
    const result: CredentialEvidence = {};
    for (const provider of providers) {
      if (configuredApiKeyShape(provider) !== null) result[provider.id] = 'api';
    }
    return result;
  }
}

export async function credentialFor(
  directory: string, providerID: string, provider: ProviderRecord, ports: SmallModelPorts,
): Promise<{ key: string; kind: 'api' | 'oauth' } | null> {
  try {
    const map = objectOf(JSON.parse(await readFile(authFile(directory, ports), { encoding: 'utf8' })));
    const entry = objectOf(map?.[providerID]);
    const key = textOf(entry?.key, 8192);
    const access = textOf(entry?.access, 8192);
    if (entry?.type === 'api' && key !== '') return { key, kind: 'api' };
    if (entry?.type === 'oauth' && access !== '') return { key: access, kind: 'oauth' };
  } catch { /* missing store is a normal no-login condition */ }
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
  const explicit = typeof ports.authFile === 'function' ? ports.authFile(directory)
    : typeof ports.authFile === 'string' ? ports.authFile : null;
  if (explicit !== null) return explicit;
  const env = process.env.NNA_AUTH_FILE ? process.env.NNA_AUTH_FILE : null;
  if (env) return env;
  const xdg = process.env.XDG_DATA_HOME ? process.env.XDG_DATA_HOME : null;
  if (xdg) return join(xdg, 'opencode', 'auth.json');
  return join(homedir(), '.local', 'share', 'opencode', 'auth.json');
}
