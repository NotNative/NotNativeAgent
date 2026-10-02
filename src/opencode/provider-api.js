// SPDX-License-Identifier: Apache-2.0
import { sendJson, sendNoContent } from './protocol.js';
import { apiError, invalid } from './v2-contract.js';
import { defaultReference } from './provider-settings.js';
import { COMPATIBLE_PACKAGE } from './provider-document.js';

export async function providerCatalog(settings, path, directory) {
  const { document, providers, secrets } = await settings.snapshot();
  const location = { directory };
  const integrations = providers.map((provider) => ({ id: provider.id, name: provider.name, methods: [{ type: 'key' }],
    connections: [...secrets.filter((secret) => secret.metadata.providerID === provider.id && secret.metadata.endpoint === provider.endpoint)
      .sort((left, right) => Number(right.enabled) - Number(left.enabled))
      .map((secret) => ({ type: 'credential', id: secret.id, label: secret.metadata.label, method: 'key' })),
    ...provider.env.filter((name) => settings.environment[name]).map((name) => ({ type: 'env', name }))] }));
  const models = providers.flatMap((provider) => Object.entries(provider.models).map(([id, model]) => modelInfo(provider, id, model)));
  if (path === '/api/agent' || path === '/api/agent/build') {
    const desired = models.some((model) => model.enabled) ? defaultReference(document, providers) : undefined;
    const reference = models.some((model) => model.enabled && model.id === desired?.id && model.providerID === desired?.providerID) ? desired : undefined;
    const agent = { id: 'build', name: 'NNA', mode: 'primary', hidden: false, ...(reference ? { model: reference } : {}),
      request: { settings: {}, headers: {}, body: {} }, permissions: [], description: 'NNA agent with authenticated reviewer governance' };
    return { location, data: path === '/api/agent' ? [agent] : agent };
  }
  if (path === '/api/model') return { location, data: models };
  if (path === '/api/model/default') {
    if (!models.some((model) => model.enabled)) return { location, data: null };
    const reference = defaultReference(document, providers);
    return { location, data: models.find((model) => model.enabled && model.id === reference.id && model.providerID === reference.providerID) ?? null };
  }
  if (path === '/api/provider') return { location, data: providers.map(providerInfo) };
  if (path.startsWith('/api/provider/')) {
    const id = decodeURIComponent(path.slice('/api/provider/'.length));
    const provider = providers.find((item) => item.id === id);
    if (!provider) throw apiError(404, 'ProviderNotFoundError', 'Provider was not found', { providerID: id });
    return { location, data: providerInfo(provider) };
  }
  if (path === '/api/integration') return { location, data: integrations };
  if (path.startsWith('/api/integration/')) {
    const id = decodeURIComponent(path.slice('/api/integration/'.length));
    const integration = integrations.find((item) => item.id === id);
    if (!integration) throw apiError(404, 'IntegrationNotFoundError', 'Integration was not found', { integrationID: id });
    return { location, data: integration };
  }
  if (path === '/api/config') return [{ type: 'document', info: document }];
  return undefined;
}

export async function providerMutation(ctx, readBody) {
  const { req, res, target, options } = ctx; const settings = options.providerSettings;
  if (!settings) return false;
  const segments = target.pathname.split('/').slice(2).map(decodeURIComponent);
  if (req.method === 'GET' && target.pathname === '/api/credential') {
    sendJson(res, 200, { data: await settings.credentialList() }); return true;
  }
  if (segments[0] === 'provider' && segments.length === 3) {
    if (req.method === 'GET' && segments[2] === 'source') {
      sendJson(res, 200, await settings.source(segments[1])); return true;
    }
    if (req.method === 'DELETE' && segments[2] === 'auth') {
      const result = await settings.remove(segments[1], target.query.scope ?? 'auth');
      announce(ctx, 'config.updated'); sendJson(res, 200, result); return true;
    }
  }
  if (req.method === 'PUT' && target.pathname === '/api/provider') {
    await settings.upsert(await readBody(ctx)); announce(ctx, 'config.updated'); sendJson(res, 200, { ok: true }); return true;
  }
  if (req.method === 'POST' && segments[0] === 'integration' && segments.length === 4 && segments[2] === 'connect' && segments[3] === 'key') {
    await settings.connect(segments[1], await readBody(ctx)); announce(ctx, 'credential.updated'); sendNoContent(res); return true;
  }
  if (segments[0] === 'credential' && segments.length >= 2 && segments.length <= 3) {
    if (req.method === 'PATCH' && segments.length === 2) await settings.credential(segments[1], 'update', await readBody(ctx));
    else if (req.method === 'DELETE' && segments.length === 2) await settings.credential(segments[1], 'remove');
    else if (req.method === 'POST' && segments.length === 3 && segments[2] === 'activate') await settings.credential(segments[1], 'activate');
    else throw invalid('Unsupported credential operation');
    announce(ctx, 'credential.updated'); sendNoContent(res); return true;
  }
  return false;
}

function announce(ctx, type) {
  ctx.options.v2.events.emit({ info: { location: { directory: ctx.options.directory } } }, type, {}, false);
  ctx.options.v2.events.emit({ info: { location: { directory: ctx.options.directory } } }, 'provider.updated', {}, false);
  ctx.options.v2.events.emit({ info: { location: { directory: ctx.options.directory } } }, 'model.updated', {}, false);
}

function providerInfo(provider) {
  return { id: provider.id, name: provider.name, integrationID: provider.id, activation: provider.activation,
    package: provider.package, settings: { baseURL: provider.endpoint } };
}

function modelInfo(provider, id, model) {
  return { id, modelID: model.modelID ?? id, providerID: provider.id, name: model.name ?? id, package: provider.protocolError ? provider.package : COMPATIBLE_PACKAGE,
    capabilities: { tools: model.capabilities?.tools !== false, input: ['text'], output: ['text'] }, variants: [],
    time: { released: 0 }, cost: [], status: 'active', enabled: provider.activation !== 'disabled' && !model.disabled,
    limit: { context: model.limit?.context ?? 0, output: model.limit?.output ?? 0 } };
}
