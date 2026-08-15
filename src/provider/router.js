// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';
import { OpenAICompatibleProvider } from '../provider.js';

// Fallback may stay within the originating trust zone or move inward, never toward broader egress.
const TRUST_ZONE_RANK = Object.freeze({ loopback: 0, private_network: 1, public_network: 2 });

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
    const route = this.config?.routes?.[role];
    if (!route) throw new ContractError('route_unavailable', `route ${role} is unavailable`);
    const routeCapabilities = route.requiredCapabilities ?? [];
    const optionCapabilities = options.requiredCapabilities ?? [];
    if (!Array.isArray(routeCapabilities) || !Array.isArray(optionCapabilities)) {
      throw new ContractError('route_capability_invalid', 'required route capabilities must be arrays');
    }
    const required = [...new Set([...routeCapabilities, ...optionCapabilities])];
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
        maxOutputTokens: cappedOutput(route.maxOutputTokens, profile.outputLimitTokens),
        reasoningEffort: route.reasoningEffort, enableThinking: route.enableThinking,
      })];
    }));
  }

  provider(resolution) {
    return this.providerForProfile(resolution.profile);
  }

  providerForProfile(profile) {
    try { return this.providerFactory(profile, this.config.limits); }
    catch (error) {
      if (error instanceof ContractError) throw error;
      const failure = new ContractError('route_provider_invalid', 'provider adapter creation failed for the selected route');
      failure.cause = error;
      throw failure;
    }
  }
}

function cappedOutput(configured, providerLimit) {
  if (!Number.isSafeInteger(configured) || configured <= 0) return null;
  return Number.isSafeInteger(providerLimit) && providerLimit > 0 ? Math.min(configured, providerLimit) : configured;
}

function orderedRoles(routes, role) {
  const ordered = [];
  const seen = new Set();
  const pending = [role];
  while (pending.length > 0) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const route = routes[current];
    if (!route) throw new ContractError('route_unavailable', `fallback route ${current} is unavailable`);
    ordered.push(current);
    const fallbacks = Array.isArray(route.fallbacks) ? route.fallbacks : [];
    for (let index = fallbacks.length - 1; index >= 0; index -= 1) pending.push(fallbacks[index]);
  }
  return ordered;
}

function incompatible(profile, required) {
  return required.some((name) => profile.capabilities?.[capabilityKey(name)] === false);
}

function capabilityKey(name) {
  return name.replace(/_([a-z])/gu, (_, character) => character.toUpperCase());
}

function trustCompatible(origin, candidate) {
  return TRUST_ZONE_RANK[candidate] <= TRUST_ZONE_RANK[origin];
}

function defaultFactory(profile, limits) {
  return new OpenAICompatibleProvider(profile, limits);
}
