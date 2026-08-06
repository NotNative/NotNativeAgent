// SPDX-License-Identifier: Apache-2.0
import { loadWebSearchConfig } from './web-search-config.js';
import { DEFAULT_WEB_FETCH_CONFIG, loadWebFetchConfig } from './web-fetch-config.js';

export async function inspectNetworkDestinations(engine) {
  const destinations = [];
  addProviders(destinations, engine.config);
  addMcp(destinations, engine.config.mcpServers);
  addTelemetry(destinations, engine.config.telemetry);
  let webSearchError = null;
  try { addWebSearch(destinations, await loadWebSearchConfig(engine.tools.webSearchConfigPath)); }
  catch (error) { webSearchError = safeCode(error?.code); }
  let webFetchError = null;
  try {
    addTrustedWebFetch(destinations, engine.tools.webFetchConfigPath
      ? await loadWebFetchConfig(engine.tools.webFetchConfigPath) : DEFAULT_WEB_FETCH_CONFIG);
  }
  catch (error) { webFetchError = safeCode(error?.code, 'web_fetch_config_invalid'); }
  addGovernedTools(destinations, engine.tools?.enabled !== false);
  addHooks(destinations, engine.hooks?.health?.());
  addExtensions(destinations, engine.extensions?.list?.() ?? []);
  return Object.freeze({
    status: webSearchError || webFetchError ? 'degraded' : 'ready', inspectable: true,
    default_unrelated_egress: false, web_search_error: webSearchError,
    web_fetch_error: webFetchError,
    destinations: Object.freeze(destinations.map((item) => Object.freeze(item))),
  });
}

function addProviders(result, config) {
  const roles = new Map();
  for (const [role, route] of Object.entries(config.routes)) {
    const list = roles.get(route.providerId) ?? []; list.push(role); roles.set(route.providerId, list);
  }
  for (const profile of Object.values(config.providerProfiles)) result.push({
    kind: 'provider', id: profile.id, destination: profile.endpoint,
    trust_zone: profile.trustZone, purpose: 'model_data',
    state: roles.has(profile.id) ? 'routed' : 'configured', active_roles: roles.get(profile.id) ?? [],
    credential_reference: profile.credentialEnv ?? null,
  });
}

function addMcp(result, servers) {
  for (const server of servers.filter((item) => item.enabled)) result.push({
    kind: 'mcp', id: server.id,
    destination: server.transport === 'streamable_http' ? server.endpoint : `process:${server.command}`,
    trust_zone: server.transport === 'streamable_http' ? zone(server.endpoint) : 'operator_process',
    purpose: 'mcp_extension', state: 'configured', transport: server.transport,
    credential_reference: server.credentialEnv ?? null,
  });
}

function addTelemetry(result, telemetry) {
  if (!telemetry?.enabled) return;
  result.push({
    kind: 'telemetry', id: 'telemetry', destination: telemetry.destination,
    trust_zone: zone(telemetry.destination), purpose: 'operator_configured_telemetry',
    state: 'configured_no_exporter', credential_reference: null,
  });
}

function addWebSearch(result, config) {
  if (!config.enabled) return;
  result.push({
    kind: 'web_search', id: 'searxng', destination: config.endpoint,
    trust_zone: zone(config.endpoint), purpose: 'reviewed_web_search',
    state: 'configured', credential_reference: null,
  });
}

function addTrustedWebFetch(result, config) {
  for (const origin of config.trusted_origins) result.push({
    kind: 'web_fetch_origin', id: origin, destination: origin,
    trust_zone: zone(origin), purpose: 'operator_trusted_bounded_fetch', state: 'configured', credential_reference: null,
  });
}

function addGovernedTools(result, enabled) {
  if (!enabled) return;
  result.push({
    kind: 'governed_tool', id: 'web.fetch', destination: 'per_request',
    trust_zone: 'public_or_explicit_origin', purpose: 'reviewed_web_fetch', state: 'review_required',
    credential_reference: null,
  }, {
    kind: 'governed_tool', id: 'process.run', destination: 'process_arguments',
    trust_zone: 'operator_reviewed', purpose: 'reviewed_process_execution', state: 'review_required',
    credential_reference: null,
  }, {
    kind: 'governed_tool', id: 'shell.run', destination: 'shell_script',
    trust_zone: 'operator_reviewed', purpose: 'reviewed_shell_execution', state: 'review_required',
    credential_reference: null,
  });
}

function addHooks(result, health) {
  for (const item of health?.bundles ?? []) {
    if (item.status !== 'loaded') continue;
    result.push({
      kind: 'hook', id: item.bundle, destination: 'configured_hook_process',
      trust_zone: 'operator_process', purpose: 'event_subscription', state: 'loaded',
      credential_reference: null,
    });
  }
}

function addExtensions(result, extensions) {
  for (const item of extensions.filter((entry) => entry.state === 'ready')) result.push({
    kind: 'extension', id: item.id, destination: 'extension_managed',
    trust_zone: 'operator_extension', purpose: 'declared_extension_capabilities', state: 'ready',
    credential_reference: null,
  });
}

function zone(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return 'loopback';
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)) return 'private_network';
    return 'public_network';
  } catch { return 'unknown'; }
}

function safeCode(value, fallback = 'web_search_config_invalid') {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,128}$/u.test(value) ? value : fallback;
}
