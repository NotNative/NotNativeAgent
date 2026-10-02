// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { invalid, objectInput, textInput } from './v2-contract.js';

export const COMPATIBLE_PACKAGE = '@opencode/ai/providers/openai-compatible';
const PACKAGES = new Set([COMPATIBLE_PACKAGE, '@opencode/ai/providers/openai/chat']);

export function providerConfigPaths(environment = process.env) {
  const root = environment.OPENCODE_CONFIG_DIR?.trim()
    || join(environment.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'opencode');
  return [join(resolve(root), 'opencode.json'), join(resolve(root), 'opencode.jsonc'),
    ...(environment.OPENCODE_CONFIG ? [resolve(environment.OPENCODE_CONFIG)] : [])];
}

export async function readProviderDocument(paths) {
  const document = { providers: Object.create(null) };
  for (const path of paths) {
    let handle;
    try {
      handle = await open(path, 'r');
      if ((await handle.stat()).size > 1_048_576) throw invalid('OpenCode configuration exceeds its size limit');
      const parsed = parseJsonc(await handle.readFile('utf8'));
      const entry = objectInput(parsed, Object.keys(parsed ?? {}));
      if (entry.providers != null && (!entry.providers || typeof entry.providers !== 'object' || Array.isArray(entry.providers))) throw invalid('Invalid OpenCode providers');
      Object.assign(document.providers, entry.providers ?? {});
      if (entry.model !== undefined) document.model = entry.model;
      for (const field of ['disabled_providers', 'enabled_providers']) {
        if (entry[field] !== undefined) {
          if (!Array.isArray(entry[field]) || entry[field].length > 128 || entry[field].some((id) => typeof id !== 'string')) throw invalid('Invalid provider availability configuration');
          document[field] = entry[field];
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { await handle?.close(); }
  }
  if (Object.keys(document.providers).length > 16) throw invalid('At most sixteen OpenCode providers are supported');
  return document;
}

export function normalizeProvider(id, input) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw invalid('Invalid provider identifier');
  objectInput(input, ['name', 'package', 'settings', 'models', 'env', 'canonical', 'headers', 'body', 'activation']);
  const packageName = input.package ?? COMPATIBLE_PACKAGE;
  if (input.activation != null && !['enabled', 'disabled', 'auto'].includes(input.activation)) throw invalid('Invalid provider activation');
  if (!PACKAGES.has(packageName)) throw invalid('This adapter supports OpenAI-compatible chat providers only');
  if (input.headers && Object.keys(input.headers).length || input.body && Object.keys(input.body).length) throw invalid('Custom provider headers and body are not supported');
  objectInput(input.settings ?? {}, ['baseURL']);
  let endpoint;
  try {
    const url = new URL(input.settings?.baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('endpoint');
    endpoint = url.href.replace(/\/$/u, '');
  } catch { throw invalid('Provider settings.baseURL must be an HTTP endpoint without credentials'); }
  const models = input.models ?? {};
  if (!models || typeof models !== 'object' || Array.isArray(models) || Object.keys(models).length > 128) throw invalid('Invalid model catalog');
  const normalized = Object.fromEntries(Object.entries(models).map(([key, value]) => {
    textInput(key, 'model ID', 256);
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) throw invalid('Invalid model identifier');
    return [key, normalizeModel(value)];
  }));
  if (input.env != null && (!Array.isArray(input.env) || input.env.length > 8 || input.env.some((name) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)))) throw invalid('Invalid provider credential environment names');
  return { id, name: textInput(input.name ?? id, 'provider name', 96), package: packageName,
    endpoint, models: normalized, env: input.env ?? [], activation: input.activation === 'disabled' ? 'disabled' : 'enabled' };
}

function normalizeModel(input) {
  objectInput(input, ['name', 'modelID', 'limit', 'capabilities', 'disabled']);
  if (input.limit) {
    objectInput(input.limit, ['context', 'input', 'output']);
    if (Object.values(input.limit).some((value) => !Number.isSafeInteger(value) || value < 1 || value > 10_000_000)) throw invalid('Invalid model token limits');
  }
  if (input.capabilities) objectInput(input.capabilities, ['tools', 'input', 'output']);
  if (input.capabilities?.tools != null && typeof input.capabilities.tools !== 'boolean') throw invalid('Invalid model tool capability');
  if (input.disabled != null && typeof input.disabled !== 'boolean') throw invalid('Invalid model availability');
  if (input.modelID != null && !textInput(input.modelID, 'modelID', 256)) throw invalid('modelID must not be empty');
  if (input.name != null) textInput(input.name, 'model name', 256);
  return structuredClone(input);
}

export function parseJsonc(source) {
  let output = ''; let quoted = false; let escaped = false; let comment = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]; const next = source[index + 1];
    if (comment === 'line') { if (char === '\n') { comment = null; output += char; } continue; }
    if (comment === 'block') { if (char === '*' && next === '/') { comment = null; index += 1; } continue; }
    if (quoted) {
      output += char;
      if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === '/' && ['/', '*'].includes(next)) { comment = next === '/' ? 'line' : 'block'; output += ' '; index += 1; continue; }
    output += char;
  }
  try { if (comment === 'block') throw new Error('comment'); return JSON.parse(removeTrailingCommas(output)); }
  catch { throw invalid('Malformed OpenCode JSON configuration'); }
}

function removeTrailingCommas(source) {
  let output = ''; let quoted = false; let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      output += char;
      if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/u.test(source[lookahead])) lookahead += 1;
      if ([']', '}'].includes(source[lookahead])) continue;
    }
    output += char;
  }
  return output;
}
