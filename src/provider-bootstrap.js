// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';
import { persistManifest } from './route-configuration.js';

const CREDENTIAL_ENV = 'NNA_PROVIDER_INITIAL_KEY';
const MAX_RESPONSE_BYTES = 1_048_576;

export async function runProviderBootstrapCommand(args, paths, options = {}) {
  const [action, endpoint, model] = args;
  if (action === 'status') return providerBootstrapStatus(paths);
  if (action === 'discover' && endpoint && !model) {
    return { models: await discoverProviderModels(endpoint, await readKey(options.input), options) };
  }
  if (action === 'configure' && endpoint && model) {
    return configureInitialProvider(paths, { endpoint, model, key: await readKey(options.input) });
  }
  throw new ContractError('provider_bootstrap_command_invalid', 'use provider status, discover ENDPOINT, or configure ENDPOINT MODEL');
}

export async function providerBootstrapStatus(paths) {
  const manifestPath = join(paths.config, 'manifest.json');
  let manifest;
  try { manifest = await readJson(manifestPath, 'provider manifest'); } catch (error) {
    if (error.code === 'ENOENT') return { configured: false };
    throw error;
  }
  resolveManifest(manifest);
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [manifest.provider].filter(Boolean);
  return { configured: providers.length > 0, count: providers.length };
}

export async function discoverProviderModels(endpoint, key = '', options = {}) {
  const normalized = normalizeEndpoint(endpoint);
  const headers = { accept: 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  let response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(`${normalized}/models`, {
      headers, signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new ContractError('provider_discovery_unreachable', 'unable to reach the provider model catalog');
  }
  if (!response.ok) throw new ContractError('provider_discovery_failed', `provider model catalog returned HTTP ${response.status}`);
  const body = JSON.parse(await boundedResponseText(response));
  const models = Array.isArray(body?.data)
    ? body.data.map((item) => item?.id).filter(validModel).slice(0, 4096) : [];
  if (models.length === 0) throw new ContractError('provider_models_empty', 'the provider returned no usable model identifiers');
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

export async function configureInitialProvider(paths, input) {
  const status = await providerBootstrapStatus(paths);
  if (status.configured) return { configured: true, skipped: true };
  const endpoint = normalizeEndpoint(input.endpoint);
  if (!validModel(input.model)) throw new ContractError('invalid_model', 'selected provider model is invalid');
  const credentialEnv = input.key ? CREDENTIAL_ENV : undefined;
  const manifest = {
    format_version: 1, routing_inheritance_version: 1, persistence: 'durable',
    providers: [{
      id: 'initial-provider', display_name: input.model, endpoint, model: input.model,
      trust_zone: endpointTrustZone(endpoint), ...(credentialEnv ? { credential_env: credentialEnv } : {}),
    }],
    routes: { primary: { provider_id: 'initial-provider', model: input.model } },
  };
  resolveManifest(manifest);
  if (input.key) await persistCredential(paths.providerCredentials, credentialEnv, input.key);
  await persistManifest(join(paths.config, 'manifest.json'), manifest);
  if (credentialEnv) process.env[credentialEnv] = input.key;
  return { configured: true, skipped: false, endpoint, model: input.model, authenticated: Boolean(input.key) };
}

export async function loadManagedProviderCredentials(paths, environment = process.env) {
  let document;
  try { document = await readJson(paths.providerCredentials, 'provider credential store'); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  if (document.format_version !== 1 || !document.credentials || typeof document.credentials !== 'object') {
    throw new ContractError('provider_credentials_invalid', 'provider credential store has an unsupported shape');
  }
  let count = 0;
  for (const [name, value] of Object.entries(document.credentials)) {
    if (name !== CREDENTIAL_ENV || typeof value !== 'string' || value.length > 16_384) {
      throw new ContractError('provider_credentials_invalid', 'provider credential store contains an invalid entry');
    }
    if (environment[name] === undefined) environment[name] = value;
    count += 1;
  }
  return count;
}

async function persistCredential(path, name, value) {
  if (typeof value !== 'string' || value.length > 16_384) throw new ContractError('provider_key_invalid', 'provider API key exceeds its bound');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ format_version: 1, credentials: { [name]: value } }, null, 2)}\n`, { mode: 0o600 });
}

async function readKey(input) {
  if (!input) return '';
  let value = '';
  for await (const chunk of input) {
    value += chunk.toString('utf8');
    if (Buffer.byteLength(value) > 16_385) throw new ContractError('provider_key_invalid', 'provider API key exceeds its bound');
  }
  return value.replace(/[\r\n]+$/u, '');
}

async function readJson(path, label) {
  const bytes = await readFile(path);
  if (bytes.length > MAX_RESPONSE_BYTES) throw new ContractError('provider_bootstrap_file_too_large', `${label} exceeds its bound`);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new ContractError('provider_bootstrap_file_invalid', `${label} is not valid UTF-8 JSON`);
  }
}

async function boundedResponseText(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new ContractError('provider_discovery_failed', 'provider model catalog returned no body');
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ContractError('provider_discovery_too_large', 'provider model catalog exceeds its bound');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function normalizeEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ContractError('invalid_endpoint', 'provider endpoint must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ContractError('invalid_endpoint', 'provider endpoint must be a credential-free HTTP(S) URL');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname || url.pathname === '/') url.pathname = '/v1';
  return url.toString().replace(/\/$/u, '');
}

function endpointTrustZone(endpoint) {
  const host = new URL(endpoint).hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return 'loopback';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)) return 'private_network';
  return 'public_network';
}

function validModel(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
