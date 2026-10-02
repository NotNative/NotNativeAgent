// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveManifest } from '../config.js';
import { ContractError } from '../ids.js';
import { withPrimaryRoute, withRoleRoute, withProvider, withUpdatedProvider, withoutProvider } from './route-configuration.js';
import { withManifestLock, readLockedManifestSnapshot, transactLockedManifest } from '../persistence/manifest-transaction.js';
import { configurationIntent, intentChanges, applyIntentChanges } from '../experience/configuration-intents.js';
import { CredentialResolver, credentialManifest, normalizeCredentialBinding } from '../credential-bindings.js';

const CREATE_FIELDS = new Set([
  'profile_id', 'display_name', 'endpoint', 'model', 'credential', 'credential_env',
  'context_limit_bytes', 'output_limit_tokens', 'tool_call_mode',
]);
const UPDATE_FIELDS = new Set([...CREATE_FIELDS].filter((field) => field !== 'profile_id'));

export class ProviderProfileStore {
  #tail = Promise.resolve();

  constructor(options) {
    this.path = options.path ?? join(options.configRoot, 'manifest.json');
    this.environment = options.environment ?? process.env;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.credentialResolver = options.credentialResolver ?? new CredentialResolver({
      secretBroker: options.secretBroker, environment: this.environment,
    });
    this.lastMutationFailure = null;
  }

  async list() {
    const config = await this.#read();
    const active = config.routes.primary.providerId;
    return Object.values(config.providerProfiles).map((profile) => publicProfile(profile, profile.id === active));
  }

  async inventory(isPending) {
    const config = await this.#read();
    const route = config.routes.primary;
    return {
      profiles: Object.values(config.providerProfiles).map((profile) => publicProfile(profile, profile.id === route.providerId)),
      configured_primary_route: { providerID: route.providerId, modelID: route.model },
      provider_routing_pending: typeof isPending === 'function' ? isPending(config) : null,
    };
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

  setPrimaryRoute(providerId, model) {
    validateRoute(providerId, model);
    return this.#mutate((config) => withPrimaryRoute(config, providerId, model), { route: true });
  }

  async subagentRoute() {
    const route = (await this.#read()).routes.subagent;
    return { providerID: route.providerId, modelID: route.model };
  }

  setSubagentRoute(providerId, model) {
    validateRoute(providerId, model);
    return this.#mutate((config) => withRoleRoute(config, 'subagent', providerId, model), { routeRole: 'subagent' });
  }

  async credential(id) {
    const config = await this.#read();
    const profile = requireProfile(config, id);
    return this.credentialResolver.withCredential(profile.credential, {
      consumer: `provider:${id}`, destination: profile.endpoint, purpose: 'Discover provider models',
      authorityRef: `provider-configuration:${id}`,
    }, async (value) => value ?? '');
  }

  async withCredential(id, context, consumer) {
    const config = await this.#read();
    const profile = requireProfile(config, id);
    return this.credentialResolver.withCredential(profile.credential, {
      consumer: `provider:${id}`, destination: profile.endpoint,
      purpose: context?.purpose ?? 'Use provider credential',
      authorityRef: context?.authorityRef ?? `provider-configuration:${id}`,
      sessionId: context?.sessionId,
    }, consumer);
  }

  async config() { return this.#read(); }

  async #read() {
    return (await this.#readSnapshot()).config;
  }

  async #readSnapshot() {
    return withManifestLock(this.path, {}, async (lease) => providerSnapshot(await readLockedManifestSnapshot(lease)));
  }

  #mutate(operation, options = {}) {
    const task = this.#tail.then(() => withManifestLock(this.path, {}, async (lease) => {
      const snapshot = providerSnapshot(await readLockedManifestSnapshot(lease));
      const config = snapshot.config;
      const result = operation(config);
      const intent = options.route || options.routeRole
        ? configurationIntent('route', { role: options.routeRole ?? 'primary' }) : configurationIntent('provider');
      const changes = intentChanges(config, result.manifest, intent);
      await transactLockedManifest(lease, { expectedRevision: snapshot.revision, operationId: randomUUID(),
        payload: { action: 'provider-configuration', changes },
        transform: (raw) => applyIntentChanges(raw, changes), validate: resolveManifest });
      this.lastMutationFailure = null;
      if (options.removedId) return { removed: options.removedId };
      if (options.route) return {
        providerID: result.config.routes.primary.providerId, modelID: result.config.routes.primary.model,
      };
      if (options.routeRole) {
        const route = result.config.routes[options.routeRole];
        return { providerID: route.providerId, modelID: route.model };
      }
      const profile = result.config.providerProfiles[options.profileId] ?? null;
      return profile ? publicProfile(profile, result.config.routes.primary.providerId === profile.id) : null;
    }));
    this.#tail = task.catch((error) => { this.lastMutationFailure = error?.code ?? 'provider_mutation_failed'; });
    return task;
  }
}

export function publicProfile(profile, active = false) {
  return Object.freeze({
    profile_id: profile.id, display_name: profile.displayName, endpoint: profile.endpoint,
    model: profile.model,
    credential: profile.credential?.source === 'secret' ? credentialManifest(profile.credential) : null,
    credential_env: profile.credential?.source === 'environment' ? profile.credential.name : null,
    context_limit_bytes: profile.contextLimitBytes ?? null,
    output_limit_tokens: profile.outputLimitTokens ?? null,
    tool_call_mode: profile.toolCallMode,
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
  if (input.credential !== undefined) result.credential = input.credential === null ? null : normalizeCredentialBinding(input.credential);
  assign(result, 'credentialEnv', input.credential_env);
  assign(result, 'contextLimitBytes', input.context_limit_bytes);
  assign(result, 'outputLimitTokens', input.output_limit_tokens);
  assign(result, 'toolCallMode', input.tool_call_mode);
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
  if (input.credential !== undefined && input.credential !== null) normalizeCredentialBinding(input.credential);
  for (const key of ['context_limit_bytes', 'output_limit_tokens']) {
    if (input[key] !== undefined && input[key] !== null && (!Number.isSafeInteger(input[key]) || input[key] < 1)) {
      throw new ContractError('provider_request_invalid', `${key} must be a positive integer or null`);
    }
  }
  if (input.tool_call_mode !== undefined && !['single', 'batch'].includes(input.tool_call_mode)) {
    throw new ContractError('provider_request_invalid', 'tool_call_mode must be single or batch');
  }
}

function assign(target, key, value) { if (value !== undefined) target[key] = value; }
function validateRoute(providerId, model) {
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(providerId)
    || typeof model !== 'string' || !model.trim() || model.length > 4096) {
    throw new ContractError('provider_request_invalid', 'provider_id and model must be bounded non-empty strings');
  }
}
function providerSnapshot(snapshot) {
  if (snapshot.state === 'missing') throw Object.assign(new Error('Provider configuration does not exist'), { code: 'ENOENT' });
  if (snapshot.rawManifest === null) throw new ContractError('provider_configuration_invalid', 'provider configuration is not valid UTF-8 JSON');
  return { config: resolveManifest(snapshot.rawManifest), revision: snapshot.revision };
}

function requireProfile(config, id) {
  const profile = config.providerProfiles[id];
  if (!profile) throw new ContractError('provider_missing', `provider ${id} is not configured`);
  return profile;
}
