// SPDX-License-Identifier: Apache-2.0
import {
  manifestFromConfig, withPrimaryRoute, withProvider, withoutProvider,
} from './route-configuration.js';

export function providerAdditionPlan(sessions, activeId, globalConfig, input) {
  let next = withProvider(globalConfig, input);
  const ids = Object.keys(globalConfig.providerProfiles);
  if (ids.length !== 1 || ids[0] !== 'auto-discovered-local') {
    return { next, entries: providerCatalogEntries(sessions, next.config) };
  }
  next = withPrimaryRoute(next.config, input.id, input.model);
  next = withoutProvider(next.config, ids[0]);
  const entries = [];
  for (const session of sessions.values()) {
    if (session.id === activeId) entries.push({ session, manifest: next.manifest, route: next.config.routes.primary });
    else {
      const current = session.engine.pendingConfig ?? session.engine.config;
      entries.push({ session, manifest: withProvider(current, input).manifest });
    }
  }
  return { next, entries };
}

export function routePresentation(config, route, prior = {}) {
  return {
    ...prior, provider: route.providerId, model: route.model,
    endpoint: config?.providerProfiles[route.providerId]?.endpoint ?? route.providerId,
  };
}

export function providerCatalogEntries(sessions, catalogConfig) {
  const entries = [];
  for (const session of sessions.values()) {
    const current = session.engine.pendingConfig ?? session.engine.config;
    const manifest = manifestFromConfig(catalogConfig);
    for (const [role, route] of Object.entries(current.routes)) preserveAssignment(manifest.routes[role], role, route);
    entries.push({ session, manifest });
  }
  return entries;
}

function preserveAssignment(manifestRoute, role, route) {
  if (role === 'primary' || route.assigned !== false) {
    manifestRoute.provider_id = route.providerId;
    manifestRoute.model = route.model;
    return;
  }
  delete manifestRoute.provider_id;
  delete manifestRoute.model;
}
