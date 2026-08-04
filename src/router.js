// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { OpenAICompatibleProvider } from './provider.js';

export class ModelRouter {
  constructor(config, providerFactory = defaultFactory) {
    this.config = config;
    this.providerFactory = providerFactory;
  }

  resolve(role, options = {}) {
    const candidates = this.candidates(role, options);
    if (candidates.length === 0) {
      throw new ContractError('route_capability_unavailable', `no trust-compatible ${role} route supports the required capabilities`);
    }
    return candidates[0];
  }

  candidates(role, options = {}) {
    const route = this.config.routes[role];
    if (!route) throw new ContractError('route_unavailable', `route ${role} is unavailable`);
    const required = [...new Set([...route.requiredCapabilities, ...(options.requiredCapabilities ?? [])])];
    const roles = orderedRoles(this.config.routes, role);
    const originZone = this.config.providerProfiles[route.providerId]?.trustZone;
    const logicalRequestId = options.logicalRequestId ?? newId('route');
    return Object.freeze(roles.flatMap((targetRole, index) => {
      const target = this.config.routes[targetRole];
      const profile = this.config.providerProfiles[target.providerId];
      if (!profile) throw new ContractError('route_profile_missing', 'route profile is unavailable');
      if (!trustCompatible(originZone, profile.trustZone) || incompatible(profile, required)) return [];
      return [Object.freeze({
        logicalRequestId, role,
        targetRole, fallback: index > 0, model: target.model, profile,
        contextLimitBytes: target.contextLimitBytes,
        requiredCapabilities: Object.freeze(required), deadlineMs: route.deadlineMs,
        budget: route.budget, temperature: route.temperature,
        maxOutputTokens: Math.min(route.maxOutputTokens, profile.outputLimitTokens ?? route.maxOutputTokens),
      })];
    }));
  }

  provider(resolution) {
    return this.providerForProfile(resolution.profile);
  }

  providerForProfile(profile) {
    return this.providerFactory(profile, this.config.limits);
  }
}

function orderedRoles(routes, role, seen = new Set()) {
  if (seen.has(role)) return [];
  seen.add(role);
  const route = routes[role];
  return [role, ...route.fallbacks.flatMap((fallback) => orderedRoles(routes, fallback, seen))];
}

function incompatible(profile, required) {
  return required.some((name) => profile.capabilities[capabilityKey(name)] === false);
}

function capabilityKey(name) {
  return name === 'structured_output' ? 'structuredOutput' : name;
}

function trustCompatible(origin, candidate) {
  const rank = { loopback: 0, private_network: 1, public_network: 2 };
  return rank[candidate] <= rank[origin];
}

function defaultFactory(profile, limits) {
  return new OpenAICompatibleProvider(profile, limits);
}
