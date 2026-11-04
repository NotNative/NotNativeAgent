// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from '../ids.js';
import { OpenAICompatibleProvider } from '../provider.js';
import { effectiveModelOutputTokens } from '../reliability/output-headroom.js';

export class ModelRouter {
  constructor(config, providerFactory = defaultFactory, options = {}) {
    this.config = config;
    this.providerFactory = providerFactory;
    this.providerOptions = options;
  }

  resolve(role, options = {}) {
    const candidates = this.candidates(role, options);
    if (candidates.length === 0) {
      throw new ContractError('route_capability_unavailable', `the ${role} route does not support the required capabilities`);
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
    const targetRole = orderedRoles(this.config.routes, role);
    const profile = this.config.providerProfiles[route.providerId];
    if (!profile) throw new ContractError('route_profile_missing', 'route profile is unavailable');
    if (incompatible(profile, required)) return Object.freeze([]);
    const logicalRequestId = options.logicalRequestId ?? newId('route');
    return Object.freeze([Object.freeze({
      logicalRequestId, role,
      targetRole, model: route.model, profile,
      contextLimitBytes: route.contextLimitBytes,
      requiredCapabilities: Object.freeze(required),
      deadlineMs: effectiveOverallDeadline(this.config, route, profile),
      budget: route.budget, temperature: route.temperature,
      maxOutputTokens: effectiveModelOutputTokens(
        route.maxOutputTokens, route.model === profile.model ? profile.outputLimitTokens : null,
      ),
      reasoningEffort: route.reasoningEffort, enableThinking: route.enableThinking,
    })]);
  }

  provider(resolution) {
    return this.providerForProfile(resolution.profile);
  }

  providerForProfile(profile) {
    try { return this.providerFactory(profile, this.config.limits, this.providerOptions); }
    catch (error) {
      if (error instanceof ContractError) throw error;
      const failure = new ContractError('route_provider_invalid', 'provider adapter creation failed for the selected route');
      failure.cause = error;
      throw failure;
    }
  }
}

function effectiveOverallDeadline(config, route, profile) {
  const explicitlyConfigured = route.deadlineOverrideMs !== null
    || config.limits.providerOverrideMs !== null;
  if (!explicitlyConfigured && profile.trustZone !== 'public_network') return null;
  return route.deadlineMs;
}

function orderedRoles(routes, role) {
  // Why: a route resolves to its own assignment or to the primary route. There is
  // no second, configurable path, so an operator reads the result in one step.
  if (!routes[role]) throw new ContractError('route_unavailable', `route ${role} is unavailable`);
  return role;
}

function incompatible(profile, required) {
  return required.some((name) => profile.capabilities?.[capabilityKey(name)] === false);
}

function capabilityKey(name) {
  return name.replace(/_([a-z])/gu, (_, character) => character.toUpperCase());
}

function defaultFactory(profile, limits, options) {
  return new OpenAICompatibleProvider(profile, limits, options);
}
