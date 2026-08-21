// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_MODEL_OUTPUT_TOKENS, LEGACY_MODEL_OUTPUT_TOKENS, OUTPUT_HEADROOM_VERSION,
} from '../reliability/output-headroom.js';

const SPECIALIST_ROLES = Object.freeze(['reviewer', 'subagent', 'vision']);

export function migrateRoutingInheritance(manifest) {
  if (manifest.format_version === 1 && manifest.routing_inheritance_version === 1
    && manifest.output_headroom_version === OUTPUT_HEADROOM_VERSION) {
    return Object.freeze({ manifest, migrated: false });
  }
  const migrated = {
    ...manifest,
    format_version: 1,
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
  return Object.freeze({ manifest: migrated, migrated: true });
}

function migrateLegacyOutputHeadroom(provider) {
  if (!record(provider) || provider.trust_zone === 'public_network'
    || provider.output_limit_tokens !== LEGACY_MODEL_OUTPUT_TOKENS) return provider;
  return { ...provider, output_limit_tokens: DEFAULT_MODEL_OUTPUT_TOKENS };
}

function legacyAutoDiscoveredRoutes(providers, routes) {
  if (providers.length !== 1 || providers[0]?.id !== 'auto-discovered-local' || !record(routes)) return false;
  const profile = providers[0];
  return SPECIALIST_ROLES.some((role) => {
    const route = routes[role];
    return record(route) && route.provider_id === profile.id && route.model === profile.model;
  });
}

function migrateLegacySpecialistRoutes(routes, profile) {
  const result = { ...routes };
  for (const role of SPECIALIST_ROLES) {
    const route = routes[role];
    if (!record(route) || route.provider_id !== profile.id || route.model !== profile.model) continue;
    const { provider_id: _providerId, model: _model, ...inherited } = route;
    result[role] = inherited;
  }
  return result;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
