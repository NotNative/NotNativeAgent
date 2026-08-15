// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline/promises';
import { isIP } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateManifestDocument, resolveManifest } from './config.js';
import { ContractError } from './ids.js';
import { persistManifest } from './provider/route-configuration.js';

const LOCAL_ENDPOINTS = Object.freeze([
  'http://127.0.0.1:11434/v1',
  'http://127.0.0.1:1234/v1',
  'http://127.0.0.1:8000/v1',
  'http://127.0.0.1:8080/v1',
]);
// Local model discovery should fail fast enough not to delay first-run interaction.
const LOCAL_PROBE_TIMEOUT_MS = 800;

export async function loadStartupManifest(options) {
  return resolveManifest(await loadStartupManifestDocument(options));
}

export async function loadStartupManifestDocument(options) {
  const path = join(options.paths.config, 'manifest.json');
  const existing = await readManifestDocumentIfPresent(path);
  if (existing) return existing;
  const fromEnvironment = manifestFromEnvironment(options.environment ?? process.env);
  const discovered = fromEnvironment ?? await (options.discover ?? discoverLocalProvider)();
  const manifest = migrateManifestDocument(discovered ?? await interactiveManifest(options.input, options.output)).manifest;
  resolveManifest(manifest);
  try {
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return loadManifestDocument(path);
  }
  options.diagnostics?.write(`nna: saved initial configuration to ${path}\n`);
  return manifest;
}

export async function discoverLocalProvider(options = {}) {
  const probe = options.probe ?? probeEndpoint;
  const results = await Promise.all(LOCAL_ENDPOINTS.map((endpoint) => probe(endpoint).catch((error) => {
    try { options.diagnostics?.write(`nna: local provider probe failed for ${endpoint} (${error?.code ?? 'probe_failed'})\n`); }
    catch { /* Discovery diagnostics are observational. */ }
    return null;
  })));
  const found = results.find((item) => item?.models?.length > 0);
  if (!found) return null;
  return providerManifest(found.endpoint, [...found.models].sort()[0], 'auto-discovered-local');
}

async function readManifestDocumentIfPresent(path) {
  try { return await loadManifestDocument(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadManifestDocument(path) {
  const bytes = await readFile(path);
  if (bytes.length > 1_048_576) throw new ContractError('manifest_too_large', 'default manifest exceeds bound');
  try {
    const document = migrateManifestDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (document.migrated) await persistManifest(path, document.manifest);
    resolveManifest(document.manifest);
    return document.manifest;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('manifest_invalid', 'default manifest is not valid UTF-8 JSON');
  }
}

function manifestFromEnvironment(environment) {
  const endpoint = environment.NNA_PROVIDER_ENDPOINT?.trim();
  const model = environment.NNA_MODEL?.trim();
  if (!endpoint && !model) return null;
  if (!endpoint || !model) {
    throw new ContractError('onboarding_env_incomplete', 'NNA_PROVIDER_ENDPOINT and NNA_MODEL must be set together');
  }
  return providerManifest(endpoint, model, 'environment-local');
}

async function interactiveManifest(input, output) {
  if (!input?.isTTY || !output?.isTTY) {
    throw new ContractError('setup_required', 'run nna in a terminal or set NNA_PROVIDER_ENDPOINT and NNA_MODEL');
  }
  const prompts = createInterface({ input, output, terminal: true });
  try {
    output.write('NotNativeAgent first-run setup\n');
    const endpoint = (await prompts.question('Provider endpoint [http://127.0.0.1:11434/v1]: ')).trim()
      || 'http://127.0.0.1:11434/v1';
    const model = (await prompts.question('Model name: ')).trim();
    if (!model) throw new ContractError('model_required', 'a model name is required');
    return providerManifest(endpoint, model, 'interactive-local');
  } finally {
    try { prompts.close(); } catch { /* Preserve the setup result or its primary failure. */ }
  }
}

function providerManifest(endpoint, model, id) {
  let url;
  try { url = new URL(endpoint); } catch { throw new ContractError('invalid_endpoint', 'provider endpoint must be a URL'); }
  const host = url.hostname.toLowerCase();
  const trustZone = ['localhost', '127.0.0.1', '::1'].includes(host) ? 'loopback'
    : privateIpv4(host) ? 'private_network' : 'public_network';
  return {
    persistence: 'durable',
    provider: { id, display_name: 'Default provider', endpoint, model, trust_zone: trustZone },
  };
}

async function probeEndpoint(endpoint) {
  const response = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
  if (!response.ok) return null;
  const text = await boundedText(response, 1_048_576);
  const value = JSON.parse(text);
  const models = Array.isArray(value.data)
    ? value.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length <= 256).slice(0, 256)
    : [];
  return models.length > 0 ? { endpoint, models } : null;
}

function privateIpv4(host) {
  if (isIP(host) !== 4) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

async function boundedText(response, maximum) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); throw new ContractError('discovery_response_too_large', 'model discovery response exceeds bound'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
