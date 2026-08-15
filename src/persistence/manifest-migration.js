// SPDX-License-Identifier: Apache-2.0

const SPECIALIST_ROLES = Object.freeze(['reviewer', 'subagent', 'vision']);

export function migrateRoutingInheritance(manifest) {
  if (manifest.format_version === 1 && manifest.routing_inheritance_version === 1) {
    return Object.freeze({ manifest, migrated: false });
  }
  const migrated = {
    ...manifest,
    format_version: 1,
    routing_inheritance_version: 1,
  };
  const providers = Array.isArray(manifest.providers) ? manifest.providers : [manifest.provider].filter(Boolean);
  if (legacyAutoDiscoveredRoutes(providers, manifest.routes)) {
    migrated.routes = migrateLegacySpecialistRoutes(manifest.routes, providers[0]);
  }
  return Object.freeze({ manifest: migrated, migrated: true });
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
