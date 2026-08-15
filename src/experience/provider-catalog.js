// SPDX-License-Identifier: Apache-2.0
import {
  manifestFromConfig, withGlobalSpecialistRoutes, withPrimaryRoute, withProvider, withoutProvider,
} from '../provider/route-configuration.js';
import { resolveManifest } from '../config.js';
import { ContractError } from '../ids.js';

export function providerAdditionPlan(sessions, activeId, globalConfig, input) {
  if (!input || typeof input !== 'object') throw new ContractError('provider_input_invalid', 'provider input is required');
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
      const current = currentSessionConfig(session);
      entries.push({ session, manifest: withProvider(current, input).manifest });
    }
  }
  return { next, entries };
}

export function routePresentation(config, route, prior = {}) {
  if (!route || typeof route.providerId !== 'string' || typeof route.model !== 'string') {
    throw new ContractError('provider_route_invalid', 'provider route is unavailable');
  }
  return {
    ...prior, provider: route.providerId, model: route.model,
    endpoint: config?.providerProfiles[route.providerId]?.endpoint ?? route.providerId,
    ...(config?.launchOverrides?.ephemeral === true ? { temporaryRoute: true } : {}),
  };
}

export function providerCatalogEntries(sessions, catalogConfig) {
  const entries = [];
  for (const session of sessions.values()) {
    const current = currentSessionConfig(session);
    const synchronized = withGlobalSpecialistRoutes(resolveCatalog(current, catalogConfig), catalogConfig);
    entries.push({ session, manifest: synchronized.manifest });
  }
  return entries;
}

export function specialistRouteEntries(sessions, globalConfig) {
  return [...sessions.values()].map((session) => {
    const current = currentSessionConfig(session);
    return { session, manifest: withGlobalSpecialistRoutes(current, globalConfig).manifest };
  });
}

export function assertProviderUnused(sessions, globalConfig, id) {
  const globalRoles = ['subagent', 'reviewer', 'vision'].filter((role) => {
    const route = globalConfig?.routes?.[role];
    return route?.providerId === id && route.assigned !== false;
  });
  if (globalRoles.length > 0) {
    throw new ContractError('provider_in_use', `provider ${id} is assigned to global ${globalRoles.join(', ')}`);
  }
  for (const session of sessions.values()) {
    const config = currentSessionConfig(session);
    if (config.routes?.primary?.providerId === id) {
      throw new ContractError('provider_in_use', `provider ${id} is the primary route in ${session.name}`);
    }
  }
}


function resolveCatalog(current, catalogConfig) {
  const manifest = manifestFromConfig(current);
  const catalogManifest = manifestFromConfig(catalogConfig);
  const currentProviders = manifest.providers;
  manifest.providers = [...catalogManifest.providers];
  const known = new Set(manifest.providers.map((provider) => provider.id));
  const primaryProviderId = current.routes?.primary?.providerId;
  if (typeof primaryProviderId !== 'string') throw new ContractError('primary_route_required', 'current provider catalog has no primary route');
  for (const provider of currentProviders) {
    if (provider.id === primaryProviderId && !known.has(provider.id)) manifest.providers.push(provider);
  }
  return resolveManifest(manifest);
}

function currentSessionConfig(session) {
  const config = session?.engine?.pendingConfig ?? session?.engine?.config;
  if (!config) throw new ContractError('session_engine_unavailable', 'session provider configuration is unavailable');
  return config;
}
