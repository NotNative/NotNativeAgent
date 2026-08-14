// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { ContractError } from './ids.js';
import {
  authenticateIntegrationRequest, readIntegrationPrincipal, requireIntegrationPermission, requireToken,
} from './integration-principal.js';
import { assertNnoIntegrationActivation } from './nno-integration-activation.js';
import { discoverProviderModels } from './provider/bootstrap.js';
import { dispatchSecretBrokerRequest, readJsonBody, send, sendFailure } from './secret-broker-server.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export async function startIntegrationServer(options) {
  assertNnoIntegrationActivation(options.activation);
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new ContractError('integration_bind_invalid', 'integration service must bind to loopback');
  const token = requireToken(options.token);
  const server = createServer((request, response) => {
    void dispatch(request, response, { ...options, token }).catch((error) => sendFailure(response, error));
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.headersTimeout = options.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = options.keepAliveTimeoutMs ?? 5_000;
  server.maxRequestsPerSocket = 100;
  await listen(server, options.port ?? 0, host);
  return Object.freeze({
    server,
    address: server.address(),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  });
}

async function dispatch(request, response, context) {
  if (!authenticateIntegrationRequest(request, context.token)) {
    return send(response, 401, failure('unauthenticated', 'valid integration credential required'));
  }
  const principal = readIntegrationPrincipal(request);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/v1/health') {
    requireIntegrationPermission(principal, 'integration.health');
    return send(response, 200, { status: 'ready', protocol: '1.0', instance_id: context.instanceId });
  }
  if (await dispatchProviderRequest(request, response, { ...context, principal, url })) return;
  if (await dispatchSecretBrokerRequest(request, response, { ...context, principal, url })) return;
  return send(response, 404, failure('not_found', 'integration endpoint not found'));
}

export async function dispatchProviderRequest(request, response, context) {
  const match = /^\/v1\/provider-profiles(?:\/([^/]+))?(?:\/(discover|test))?$/u.exec(context.url.pathname);
  if (!match) return false;
  const id = match[1] ? decodeURIComponent(match[1]) : null;
  const action = match[2] ?? null;
  const { principal, providerStore } = context;
  if (request.method === 'GET' && !id) {
    requireIntegrationPermission(principal, 'provider.read');
    return send(response, 200, { profiles: await providerStore.list() });
  }
  if (request.method === 'GET' && id && !action) {
    requireIntegrationPermission(principal, 'provider.read');
    const profile = await providerStore.get(id);
    return profile ? send(response, 200, { profile }) : send(response, 404, failure('provider_missing', 'provider profile not found'));
  }
  if (request.method === 'POST' && !id) {
    requireIntegrationPermission(principal, 'provider.manage');
    return send(response, 201, { profile: await providerStore.create(await readJsonBody(request)) });
  }
  if (request.method === 'PATCH' && id && !action) {
    requireIntegrationPermission(principal, 'provider.manage');
    return send(response, 200, { profile: await providerStore.update(id, await readJsonBody(request)) });
  }
  if (request.method === 'DELETE' && id && !action) {
    requireIntegrationPermission(principal, 'provider.manage');
    return send(response, 200, await providerStore.remove(id));
  }
  if (request.method === 'POST' && id && action === 'discover') {
    requireIntegrationPermission(principal, 'provider.discover');
    const profile = await requiredProfile(providerStore, id);
    const models = await discoverProviderModels(profile.endpoint, await providerStore.credential(id), {
      fetch: providerStore.fetch, timeoutMs: context.providerTimeoutMs ?? 30_000,
    });
    return send(response, 200, { profile_id: id, models });
  }
  if (request.method === 'POST' && id && action === 'test') {
    requireIntegrationPermission(principal, 'provider.test');
    const profile = await requiredProfile(providerStore, id);
    const models = await discoverProviderModels(profile.endpoint, await providerStore.credential(id), {
      fetch: providerStore.fetch, timeoutMs: context.providerTimeoutMs ?? 30_000,
    });
    return send(response, 200, {
      profile_id: id, status: models.includes(profile.model) ? 'ready' : 'model_unavailable',
      selected_model: profile.model, discovered_models: models.length,
    });
  }
  return send(response, 405, failure('method_not_allowed', 'method is not supported for this endpoint'));
}

async function requiredProfile(store, id) {
  const profile = await store.get(id);
  if (!profile) throw new ContractError('provider_missing', `provider ${id} is not configured`);
  return profile;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

function failure(code, message) { return { error: { code, message } }; }
