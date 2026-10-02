// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { persistAtomicJson } from '../persistence/atomic-json.js';
import { invalid, objectInput } from './v2-contract.js';
import { normalizeProvider, parseJsonc, validateProviderID } from './provider-document.js';

async function layers(settings) {
  const result = [];
  for (const path of settings.paths) {
    let handle;
    try {
      handle = await open(path, 'r');
      if ((await handle.stat()).size > 1_048_576) throw invalid('OpenCode configuration exceeds its size limit');
      const document = parseJsonc(await handle.readFile('utf8'));
      objectInput(document, Object.keys(document ?? {}));
      if (document.providers != null) objectInput(document.providers, Object.keys(document.providers));
      result.push({ path, scope: resolve(path) === settings.customPath ? 'custom' : 'user', document });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      result.push({ path, scope: resolve(path) === settings.customPath ? 'custom' : 'user', document: {} });
    } finally { await handle?.close(); }
  }
  return result;
}

export async function providerSource(settings, id) {
  validateProviderID(id);
  const entries = await layers(settings);
  const sources = { user: { exists: false, path: null }, project: { exists: false, path: null },
    custom: { exists: false, path: null }, auth: { exists: false } };
  let config = null;
  for (const entry of entries) {
    if (!Object.hasOwn(entry.document.providers ?? {}, id)) continue;
    const provider = normalizeProvider(id, entry.document.providers[id], { allowUnsupported: true });
    sources[entry.scope] = { exists: true, path: entry.path };
    // Security: project only validated public form fields; never return raw provider settings or keys.
    config = { name: provider.name, package: provider.package, settings: { baseURL: provider.endpoint },
      models: provider.models, env: provider.env };
  }
  sources.auth.exists = (await settings.broker.list()).some((secret) => secret.metadata.providerID === id);
  return { providerId: id, sources, config };
}

export async function writeProvider(settings, id, config, scope = 'user') {
  if (!['user', 'custom'].includes(scope)) throw invalid('Only OpenCode user or configured custom provider configuration can be changed');
  const entries = (await layers(settings)).filter((entry) => entry.scope === scope);
  const target = entries.findLast((entry) => Object.hasOwn(entry.document.providers ?? {}, id)) ?? entries.at(-1);
  if (!target) throw invalid('The requested OpenCode configuration scope is not configured');
  await persistAtomicJson(target.path, { ...target.document, providers: { ...target.document.providers, [id]: config } });
}

export async function removeProvider(settings, id, scope) {
  validateProviderID(id);
  if (!['user', 'custom', 'all'].includes(scope)) throw invalid('Remove provider configuration with scope=user, custom or all; remove keys through credential routes');
  const entries = await layers(settings); let removed = false;
  if (scope === 'custom' && !entries.some((entry) => entry.scope === scope)) throw invalid('The requested OpenCode configuration scope is not configured');
  const selected = entries.filter((entry) => scope === 'all' || entry.scope === scope);
  if (!selected.some((entry) => Object.hasOwn(entry.document.providers ?? {}, id))) return { success: true, removed: false, requiresReload: false };
  // Invariant: remove every matching entry in the named scope so a lower layer cannot restore it.
  for (const entry of selected) {
    const document = entry.document;
    const present = Object.hasOwn(document.providers ?? {}, id);
    const referenced = typeof document.model === 'string' && document.model.startsWith(`${id}/`);
    if (!present && !referenced && !['enabled_providers', 'disabled_providers'].some((field) => Array.isArray(document[field]) && document[field].includes(id))) continue;
    if (present) delete document.providers[id];
    if (typeof document.model === 'string' && document.model.startsWith(`${id}/`)) delete document.model;
    for (const field of ['enabled_providers', 'disabled_providers']) {
      if (Array.isArray(document[field])) document[field] = document[field].filter((providerID) => providerID !== id);
    }
    await persistAtomicJson(entry.path, document); removed ||= present;
  }
  return { success: true, removed, requiresReload: false };
}
