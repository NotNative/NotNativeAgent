// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
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
    const bytes = await readFile(this.path);
    if (bytes.length > FILE_LIMIT) throw new ContractError('provider_configuration_too_large', 'provider configuration exceeds its size bound');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ContractError('provider_configuration_invalid', 'provider configuration is not valid UTF-8 JSON'); }
    return resolveManifest(value);
  }

  #mutate(operation, options = {}) {
    const task = this.#tail.then(async () => {
      const config = await this.#read();
      const result = operation(config);
      await persistManifest(this.path, result.manifest);
      if (options.removedId) return { removed: options.removedId };
      const profile = result.config.providerProfiles[options.profileId] ?? null;
      return profile ? publicProfile(profile, result.config.routes.primary.providerId === profile.id) : null;
    });
    this.#tail = task.catch(() => undefined);
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
  const result = {
    id: creating ? input.profile_id : undefined,
    displayName: input.display_name, endpoint: input.endpoint, model: input.model,
    credentialEnv: input.credential_env === null ? null : input.credential_env,
    contextLimitBytes: input.context_limit_bytes, outputLimitTokens: input.output_limit_tokens,
  };
  if (creating && (!result.id || !result.endpoint || !result.model)) {
    throw new ContractError('provider_request_invalid', 'profile_id, endpoint, and model are required');
  }
  return result;
}

function requireProfile(config, id) {
  const profile = config.providerProfiles[id];
  if (!profile) throw new ContractError('provider_missing', `provider ${id} is not configured`);
  return profile;
}
