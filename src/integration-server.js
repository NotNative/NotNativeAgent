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
const PROVIDER_ROUTE = /^\/v1\/provider-profiles(?:\/([^/]+))?(?:\/(discover|test))?$/u;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_SERVER_TIMEOUT_MS = 300_000;

export async function startIntegrationServer(options) {
  assertNnoIntegrationActivation(options.activation);
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) throw new ContractError('integration_bind_invalid', 'integration service must bind to loopback');
  const token = requireToken(options.token);
  const server = createServer((request, response) => {
    void dispatch(request, response, { ...options, token }).catch((error) => sendFailure(response, error));
  });
  server.requestTimeout = boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'request');
  server.headersTimeout = boundedTimeout(options.headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS, 'headers');
  server.keepAliveTimeout = boundedTimeout(options.keepAliveTimeoutMs, DEFAULT_KEEP_ALIVE_TIMEOUT_MS, 'keep-alive');
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
  const match = PROVIDER_ROUTE.exec(context.url.pathname);
  if (!match) return false;
  const id = match[1] ? providerId(match[1]) : null;
  const action = match[2] ?? null;
  const { principal, providerStore } = context;
  assertProviderStore(providerStore);
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
    const { models } = await discoverModels(providerStore, id, context.providerTimeoutMs);
    return send(response, 200, { profile_id: id, models });
  }
  if (request.method === 'POST' && id && action === 'test') {
    requireIntegrationPermission(principal, 'provider.test');
    const { profile, models } = await discoverModels(providerStore, id, context.providerTimeoutMs);
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

async function discoverModels(store, id, configuredTimeoutMs) {
  const profile = await requiredProfile(store, id);
  const endpoint = providerEndpoint(profile.endpoint);
  const models = await discoverProviderModels(endpoint, await store.credential(id), {
    fetch: store.fetch, timeoutMs: boundedTimeout(configuredTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 'provider'),
  });
  return { profile, models };
}

function providerEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new ContractError('invalid_endpoint', 'provider endpoint must be an HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ContractError('invalid_endpoint', 'provider endpoint must be a credential-free HTTP(S) URL');
  }
  return url.toString().replace(/\/$/u, '');
}

function providerId(encoded) {
  let id;
  try { id = decodeURIComponent(encoded); } catch { throw new ContractError('provider_id_invalid', 'provider id is invalid'); }
  if (!PROVIDER_ID.test(id)) throw new ContractError('provider_id_invalid', 'provider id is invalid');
  return id;
}

function assertProviderStore(store) {
  if (!store || ['list', 'get', 'create', 'update', 'remove', 'credential'].some((method) => typeof store[method] !== 'function')) {
    throw new ContractError('provider_store_unavailable', 'provider profile store is unavailable');
  }
}

function boundedTimeout(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 100 || selected > MAX_SERVER_TIMEOUT_MS) {
    throw new ContractError('integration_timeout_invalid', `${label} timeout is outside the supported range`);
  }
  return selected;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

function failure(code, message) { return { error: { code, message } }; }
