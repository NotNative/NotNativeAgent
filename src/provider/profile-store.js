// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveManifest } from '../config.js';
import { ContractError } from '../ids.js';
import { persistManifest, withProvider, withUpdatedProvider, withoutProvider } from './route-configuration.js';

const FILE_LIMIT = 1_048_576;
const CREATE_FIELDS = new Set([
  'profile_id', 'display_name', 'endpoint', 'model', 'credential_env',
  'context_limit_bytes', 'output_limit_tokens',
]);
const UPDATE_FIELDS = new Set([...CREATE_FIELDS].filter((field) => field !== 'profile_id'));

export class ProviderProfileStore {
  #tail = Promise.resolve();

  constructor(options) {
    this.path = options.path ?? join(options.configRoot, 'manifest.json');
    this.environment = options.environment ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.lastMutationFailure = null;
  }

  async list() {
    const config = await this.#read();
    const active = config.routes.primary.providerId;
    return Object.values(config.providerProfiles).map((profile) => publicProfile(profile, profile.id === active));
  }

  async get(id) {
    const config = await this.#read();
    const profile = config.providerProfiles[id];
    return profile ? publicProfile(profile, config.routes.primary.providerId === id) : null;
  }

  create(input) {
    const normalized = normalizeInput(input, true);
    return this.#mutate((config) => withProvider(config, normalized), { profileId: normalized.id });
  }

  update(id, input) {
    return this.#mutate((config) => withUpdatedProvider(config, id, normalizeInput(input, false)), { profileId: id });
  }

  remove(id) {
    return this.#mutate((config) => withoutProvider(config, id), { removedId: id });
  }

  async credential(id) {
    const config = await this.#read();
    const profile = requireProfile(config, id);
    if (!profile.credentialEnv) return '';
    const value = this.environment[profile.credentialEnv];
    if (typeof value !== 'string') throw new ContractError('missing_credential', `provider credential ${profile.credentialEnv} is unavailable`);
    return value;
  }

  async config() { return this.#read(); }

  async #read() {
    return (await this.#readSnapshot()).config;
  }

  async #readSnapshot() {
    const bytes = await readFile(this.path);
    if (bytes.length > FILE_LIMIT) throw new ContractError('provider_configuration_too_large', 'provider configuration exceeds its size bound');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ContractError('provider_configuration_invalid', 'provider configuration is not valid UTF-8 JSON'); }
    return { config: resolveManifest(value), fingerprint: digest(bytes) };
  }

  #mutate(operation, options = {}) {
    const task = this.#tail.then(async () => {
      const snapshot = await this.#readSnapshot();
      const config = snapshot.config;
      const result = operation(config);
      const currentFingerprint = digest(await readFile(this.path));
      if (currentFingerprint !== snapshot.fingerprint) {
        throw new ContractError('provider_configuration_conflict', 'provider configuration changed during the update; retry against the latest version');
      }
      await persistManifest(this.path, result.manifest);
      this.lastMutationFailure = null;
      if (options.removedId) return { removed: options.removedId };
      const profile = result.config.providerProfiles[options.profileId] ?? null;
      return profile ? publicProfile(profile, result.config.routes.primary.providerId === profile.id) : null;
    });
    this.#tail = task.catch((error) => { this.lastMutationFailure = error?.code ?? 'provider_mutation_failed'; });
    return task;
  }
}

export function publicProfile(profile, active = false) {
  return Object.freeze({
    profile_id: profile.id, display_name: profile.displayName, endpoint: profile.endpoint,
    model: profile.model, credential_env: profile.credentialEnv ?? null,
    context_limit_bytes: profile.contextLimitBytes ?? null,
    output_limit_tokens: profile.outputLimitTokens ?? null,
    active,
  });
}

function normalizeInput(input, creating) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContractError('provider_request_invalid', 'provider request body must be an object');
  const allowed = creating ? CREATE_FIELDS : UPDATE_FIELDS;
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new ContractError('provider_request_invalid', 'provider request contains an unknown field');
  }
  validateInputValues(input, creating);
  const result = {};
  assign(result, 'id', creating ? input.profile_id : undefined);
  assign(result, 'displayName', input.display_name);
  assign(result, 'endpoint', input.endpoint);
  assign(result, 'model', input.model);
  assign(result, 'credentialEnv', input.credential_env);
  assign(result, 'contextLimitBytes', input.context_limit_bytes);
  assign(result, 'outputLimitTokens', input.output_limit_tokens);
  if (creating && (!result.id || !result.endpoint || !result.model)) {
    throw new ContractError('provider_request_invalid', 'profile_id, endpoint, and model are required');
  }
  return result;
}

function validateInputValues(input, creating) {
  const requiredStrings = creating ? ['profile_id', 'endpoint', 'model'] : [];
  if (requiredStrings.some((key) => typeof input[key] !== 'string' || !input[key].trim())) {
    throw new ContractError('provider_request_invalid', 'profile_id, endpoint, and model must be non-empty strings');
  }
  for (const key of ['display_name', 'endpoint', 'model', 'credential_env']) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'string' || input[key].length > 4096)) {
      throw new ContractError('provider_request_invalid', `${key} must be a bounded string or null`);
    }
  }
  for (const key of ['context_limit_bytes', 'output_limit_tokens']) {
    if (input[key] !== undefined && input[key] !== null && (!Number.isSafeInteger(input[key]) || input[key] < 1)) {
      throw new ContractError('provider_request_invalid', `${key} must be a positive integer or null`);
    }
  }
}

function assign(target, key, value) { if (value !== undefined) target[key] = value; }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }

function requireProfile(config, id) {
  const profile = config.providerProfiles[id];
  if (!profile) throw new ContractError('provider_missing', `provider ${id} is not configured`);
  return profile;
}
