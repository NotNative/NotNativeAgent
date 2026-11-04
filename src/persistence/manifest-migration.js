// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_MODEL_OUTPUT_TOKENS, LEGACY_MODEL_OUTPUT_TOKENS, OUTPUT_HEADROOM_VERSION,
} from '../reliability/output-headroom.js';
import { isRecord } from '../values.js';

const SPECIALIST_ROLES = Object.freeze(['reviewer', 'subagent', 'vision']);
export const CONNECTION_FORMAT_VERSION = 2;
const CONNECTION_MARKER = 'manifest_connection_version';

export function migrateRoutingInheritance(manifest) {
  if (manifest.format_version === CONNECTION_FORMAT_VERSION && manifest[CONNECTION_MARKER] === 1
    && manifest.routing_inheritance_version === 1
    && manifest.output_headroom_version === OUTPUT_HEADROOM_VERSION) {
    return Object.freeze({ manifest, migrated: false });
  }
  const migrated = {
    ...manifest,
    format_version: CONNECTION_FORMAT_VERSION,
    [CONNECTION_MARKER]: 1,
    routing_inheritance_version: 1,
    output_headroom_version: OUTPUT_HEADROOM_VERSION,
  };
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [manifest.provider].filter(Boolean);
  if (legacyAutoDiscoveredRoutes(providers, manifest.routes)) {
    migrated.routes = migrateLegacySpecialistRoutes(manifest.routes, providers[0]);
  }
  if (manifest.output_headroom_version !== OUTPUT_HEADROOM_VERSION) {
    if (Array.isArray(manifest.providers)) migrated.providers = providers.map(migrateLegacyOutputHeadroom);
    else if (manifest.provider) migrated.provider = migrateLegacyOutputHeadroom(manifest.provider);
  }
  if (manifest[CONNECTION_MARKER] !== 1) migrateConnections(migrated);
  // Why: a document whose providers cannot migrate keeps its original version, so validation
  // reports the provider defect instead of a missing connection list.
  if (!Array.isArray(migrated.connections) && (migrated.providers || migrated.provider)) {
    migrated.format_version = manifest.format_version;
    delete migrated[CONNECTION_MARKER];
  }
  return Object.freeze({ manifest: migrated, migrated: true });
}

// Why: one connection owns the network identity and the credential. Two stored providers
// that agree on both become one connection with two model selections; two providers that
// differ in any of endpoint, trust zone, or credential stay separate connections, because
// merging them would drop a credential binding.
function migrateConnections(manifest) {
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [manifest.provider].filter(Boolean);
  if (providers.length === 0) return;
  // Why: a malformed provider record must reach the validator unchanged so it reports the
  // exact defect, so a document holding one is not rewritten into connections at all.
  if (!providers.every(validProviderRecord)) return;
  const connections = [];
  const selections = [];
  const connectionByKey = new Map();
  const providerToConnection = new Map();
  // Why: a stored provider may already use the generated identifier, so a fixed
  // positional name would collide with it and fail the trust-zone check downstream.
  // The provider's own id is preferred so a migrated document reads like the operator wrote it.
  const taken = new Set();
  for (const provider of providers) {
    const key = connectionKey(provider);
    let connection = connectionByKey.get(key);
    if (!connection) {
      connection = connectionRecord(provider, connectionId(taken, provider.id ?? 'manifest-primary'));
      connectionByKey.set(key, connection);
      connections.push(connection);
    }
    const selection = selectionRecord(provider, connection.id);
    providerToConnection.set(provider.id ?? 'manifest-primary', selection.id);    selections.push(selection);
  }
  if (connections.length === 0) return;
  manifest.connections = connections;
  manifest.model_selections = selections;
  delete manifest.providers;
  delete manifest.provider;
  if (isRecord(manifest.routes)) {
    for (const route of Object.values(manifest.routes)) {
      if (!isRecord(route)) continue;
      // Why: a route names the selection that serves it, and the selection id is the stored
      // provider id, so a migrated route keeps the exact model choice the operator made.
      const selectionId = providerToConnection.get(route.provider_id);
      if (selectionId !== undefined) route.selection_id = selectionId;
      delete route.provider_id;
    }  }
}

// Why: a stored provider may already use the generated identifier, so a fixed
// positional name would collide with it and fail the trust-zone check downstream.
// The provider's own id is preferred so a migrated document reads like the operator wrote it.
function connectionId(taken, preferred) {
  if (typeof preferred === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(preferred) && !taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }
  for (let index = taken.size + 1; ; index += 1) {
    const candidate = `connection_${index}`;
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    return candidate;
  }
}

// Why: a malformed provider record must reach the validator, not be silently dropped or repaired.
// A provider without an id is valid and takes the legacy default identity.
function validProviderRecord(provider) {
  return (provider.id === undefined || (typeof provider.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(provider.id)))
    && typeof provider.endpoint === 'string' && typeof provider.model === 'string'
    && typeof provider.trust_zone === 'string';
}

function connectionKey(provider) {
  return [provider.endpoint, provider.trust_zone, credentialKey(provider)].join('\u0000');
}

function credentialKey(provider) {
  const credential = provider.credential;
  if (isRecord(credential)) return `${credential.source ?? ''}:${credential.secret_id ?? ''}:${credential.field ?? ''}`;
  return typeof provider.credential_env === 'string' ? `environment:${provider.credential_env}` : '';
}

function connectionRecord(provider, id) {
  // Why: keys this migration does not own stay on the connection record, so the reader still reports
  // an unknown or security-relevant key with the path that now holds it.
  const known = new Set(['id', 'display_name', 'endpoint', 'model', 'trust_zone', 'credential', 'credential_env',
    'context_limit_bytes', 'output_limit_tokens', 'tool_call_mode', 'capabilities']);
  const extra = Object.fromEntries(Object.entries(provider).filter(([key]) => !known.has(key)));
  const connection = {
    ...extra,
    id,
    display_name: provider.display_name ?? provider.id ?? id,
    endpoint: provider.endpoint,
    trust_zone: provider.trust_zone,
  };
  if (isRecord(provider.credential)) connection.credential = { ...provider.credential };
  if (typeof provider.credential_env === 'string') connection.credential_env = provider.credential_env;
  return connection;
}

function selectionRecord(provider, connectionId) {
  const selection = {
    id: provider.id ?? 'manifest-primary',
    connection_id: connectionId,
    model: provider.model,
  };
  if (Number.isSafeInteger(provider.context_limit_bytes)) selection.context_limit_bytes = provider.context_limit_bytes;
  if (Number.isSafeInteger(provider.output_limit_tokens)) selection.output_limit_tokens = provider.output_limit_tokens;
  if (provider.tool_call_mode !== undefined) selection.tool_call_mode = provider.tool_call_mode;
  if (isRecord(provider.capabilities)) selection.capabilities = { ...provider.capabilities };
  return selection;
}

function migrateLegacyOutputHeadroom(provider) {
  if (!isRecord(provider) || provider.trust_zone === 'public_network'
    || provider.output_limit_tokens !== LEGACY_MODEL_OUTPUT_TOKENS) return provider;
  return { ...provider, output_limit_tokens: DEFAULT_MODEL_OUTPUT_TOKENS };
}

function legacyAutoDiscoveredRoutes(providers, routes) {
  if (providers.length !== 1 || providers[0]?.id !== 'auto-discovered-local' || !isRecord(routes)) return false;
  const profile = providers[0];
  return SPECIALIST_ROLES.some((role) => {
    const route = routes[role];
    return isRecord(route) && route.provider_id === profile.id && route.model === profile.model;
  });
}

function migrateLegacySpecialistRoutes(routes, profile) {
  const result = { ...routes };
  for (const role of SPECIALIST_ROLES) {
    const route = routes[role];
    if (!isRecord(route) || route.provider_id !== profile.id || route.model !== profile.model) continue;
    const { provider_id: _providerId, model: _model, ...inherited } = route;
    result[role] = inherited;
  }
  return result;
}

