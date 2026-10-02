// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SecretBroker } from '../secret-broker.js';
import { resolveManifest } from '../config.js';
import { manifestFromConfig } from '../provider/route-configuration.js';
import { apiError, invalid, objectInput, textInput } from './v2-contract.js';
import { normalizeProvider, providerConfigPaths, readProviderDocument } from './provider-document.js';
import { providerSource, removeProvider, writeProvider } from './provider-configuration.js';

export class OpenCodeProviderSettings {
  #tail = Promise.resolve();
  #pending = 0;
  constructor(options) {
    this.paths = options.configPaths ?? providerConfigPaths(options.environment);
    this.environment = options.environment ?? process.env;
    if (!Array.isArray(this.paths) || this.paths.length < 1 || this.paths.length > 3 || this.paths.some((path) => typeof path !== 'string' || !path)) throw invalid('Invalid OpenCode configuration paths');
    this.paths = [...new Set(this.paths.map((path) => resolve(path)))];
    this.customPath = this.environment.OPENCODE_CONFIG ? resolve(this.environment.OPENCODE_CONFIG) : undefined;
    this.broker = new SecretBroker({ realm: 'opencode.local', vaultPath: join(options.root, 'secrets', 'vault.json'),
      keyPath: join(options.root, 'secrets', 'master-key.json'), auditPath: join(options.root, 'secrets', 'audit.ndjson') });
    // Security: credential use is bound to the endpoint approved when the key was connected.
    this.secretBroker = { withSecret: async (id, request, consumer) => {
      const secret = await this.broker.get(id);
      if (!secret || secret.metadata.endpoint !== request.destination) throw invalid('Reconnect the OpenCode credential for this provider endpoint');
      return this.broker.withSecret(id, request, consumer);
    } };
  }

  async snapshot() {
    const document = await readProviderDocument(this.paths);
    const providers = Object.entries(document.providers).map(([id, input]) => normalizeProvider(id, input, { allowUnsupported: true }));
    for (const provider of providers) {
      if (document.disabled_providers?.includes(provider.id) || document.enabled_providers && !document.enabled_providers.includes(provider.id)) provider.activation = 'disabled';
    }
    const secrets = await this.broker.list();
    return { document, providers, secrets };
  }

  async selection(reference) {
    const snapshot = await this.snapshot();
    const desired = reference ?? defaultReference(snapshot.document, snapshot.providers);
    objectInput(desired, ['id', 'providerID']);
    const requested = snapshot.providers.find((item) => item.id === desired.providerID);
    if (requested?.protocolError) throw invalid(requested.protocolError);
    const provider = snapshot.providers.find((item) => item.id === desired.providerID && item.activation !== 'disabled');
    if (!provider || !Object.hasOwn(provider.models, desired.id) || provider.models[desired.id].disabled) throw invalid('Select an enabled model configured for OpenCode');
    const secret = snapshot.secrets.find((item) => item.enabled && item.metadata.providerID === provider.id && item.metadata.endpoint === provider.endpoint);
    const environmentName = provider.env.find((name) => this.environment[name]);
    const credential = secret ? { source: 'secret', secret_id: secret.id, field: 'key' }
      : environmentName ? { source: 'environment', name: environmentName } : undefined;
    return { reference: { id: desired.id, providerID: provider.id }, provider, model: provider.models[desired.id], credential };
  }

  async runtimeConfig(base, reference, directory) {
    if (base.executionManifest) throw invalid('OpenCode provider changes are unavailable under an authenticated execution manifest');
    const selected = await this.selection(reference);
    const manifest = manifestFromConfig(base);
    const profile = selected.provider; const limits = selected.model.limit ?? {};
    manifest.providers = [{ id: profile.id, display_name: profile.name, endpoint: profile.endpoint,
      model: selected.model.modelID ?? selected.reference.id, trust_zone: trustZone(profile.endpoint), credential: selected.credential,
      output_limit_tokens: limits.output, context_limit_bytes: limits.context ? limits.context * 4 : undefined,
      capabilities: { tools: selected.model.capabilities?.tools !== false, images: false } }];
    manifest.routes = { primary: { provider_id: profile.id, model: selected.model.modelID ?? selected.reference.id } };
    manifest.workspace_root = directory ?? base.workspaceRoot;
    return { config: resolveManifest(manifest), reference: selected.reference };
  }

  mutate(operation) {
    if (this.#pending >= 32) throw apiError(503, 'ServiceUnavailableError', 'OpenCode settings are busy');
    this.#pending += 1;
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {}).finally(() => { this.#pending -= 1; });
    return result;
  }

  connect(providerID, input) {
    objectInput(input, ['key', 'label', 'answer']); textInput(input.key, 'key', 20_000);
    if (!input.key || input.answer != null) throw invalid('An API key without additional form answers is required');
    if (input.label != null && !textInput(input.label, 'label', 96).trim()) throw invalid('Credential label must not be empty');
    return this.mutate(async () => {
      const { providers, secrets } = await this.snapshot();
      const provider = providers.find((item) => item.id === providerID);
      if (!provider) throw apiError(404, 'IntegrationNotFoundError', 'Integration was not found', { integrationID: providerID });
      if (provider.protocolError) throw invalid(provider.protocolError);
      const label = input.label ?? provider.name;
      const existing = secrets.find((secret) => secret.metadata.providerID === providerID && secret.metadata.label === label && secret.metadata.endpoint === provider.endpoint);
      if (existing) { await this.broker.rotate(existing.id, { key: input.key }); await this.activateSecret(existing.id); return; }
      if (secrets.length >= 128) throw invalid('OpenCode credential limit reached');
      const secret = await this.broker.create({ label: `opencode-${randomUUID()}`, kind: 'api_key', fields: { key: input.key },
        scope: { kind: 'user', id: 'opencode' }, metadata: { providerID, endpoint: provider.endpoint, label } });
      await this.activateSecret(secret.id);
    });
  }

  async activateSecret(id) {
    const secrets = await this.broker.list(); const selected = secrets.find((secret) => secret.id === id);
    if (!selected) throw invalid('OpenCode credential was not found');
    await this.broker.setEnabled(id, true);
    for (const secret of secrets) if (secret.id !== id && secret.metadata.providerID === selected.metadata.providerID && secret.enabled) await this.broker.setEnabled(secret.id, false);
  }

  credential(id, operation, input = {}) {
    return this.mutate(async () => {
      if (!(await this.broker.get(id))) throw invalid('OpenCode credential was not found');
      if (operation === 'activate') return this.activateSecret(id);
      if (operation === 'remove') {
        const removed = await this.broker.get(id);
        await this.broker.remove(id);
        const next = (await this.broker.list()).find((secret) => secret.metadata.providerID === removed.metadata.providerID && secret.metadata.endpoint === removed.metadata.endpoint);
        if (removed.enabled && next) await this.activateSecret(next.id);
        return;
      }
      objectInput(input, ['label']);
      if (!textInput(input.label, 'label', 96).trim()) throw invalid('Credential label must not be empty');
      const secret = await this.broker.get(id);
      return this.broker.update(id, { metadata: { ...secret.metadata, label: input.label } });
    });
  }

  upsert(input) {
    objectInput(input, ['providerID', 'config', 'scope', 'hasCredential']);
    if (input.scope != null && !['user', 'custom'].includes(input.scope)) throw invalid('Only OpenCode user or configured custom provider configuration can be changed');
    normalizeProvider(input.providerID, input.config);
    return this.mutate(async () => {
      // Compatibility: replacing an unsupported provider must not require its old protocol to load.
      const document = await readProviderDocument(this.paths);
      document.providers[input.providerID] = input.config;
      if (Object.keys(document.providers).length > 16) throw invalid('OpenCode provider limit reached');
      await writeProvider(this, input.providerID, input.config, input.scope);
    });
  }

  source(id) { return providerSource(this, id); }

  remove(id, scope) { return this.mutate(() => removeProvider(this, id, scope)); }

  async credentialList() {
    const { providers, secrets } = await this.snapshot();
    // Security: OpenChamber checks active credential presence through this route; raw keys stay in trusted transport.
    return secrets.map((secret) => ({ id: secret.id, integrationID: secret.metadata.providerID,
      label: secret.metadata.label, active: secret.enabled && providers.some((provider) => !provider.protocolError
        && provider.id === secret.metadata.providerID && provider.endpoint === secret.metadata.endpoint),
      value: { type: 'key', key: '', metadata: { nna_redacted: true } } }));
  }
}

export function defaultReference(document, providers) {
  if (typeof document.model === 'string' && document.model.includes('/')) {
    const separator = document.model.indexOf('/');
    return { providerID: document.model.slice(0, separator), id: document.model.slice(separator + 1) };
  }
  const provider = providers.find((item) => item.activation !== 'disabled' && Object.values(item.models).some((model) => !model.disabled));
  if (!provider) throw invalid('Configure an OpenCode provider and model in OpenChamber first');
  return { providerID: provider.id, id: Object.keys(provider.models).find((id) => !provider.models[id].disabled) };
}

function trustZone(endpoint) {
  const host = new URL(endpoint).hostname;
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return 'loopback';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)) return 'private_network';
  return 'public_network';
}
