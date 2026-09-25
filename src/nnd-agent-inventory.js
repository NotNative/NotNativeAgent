// SPDX-License-Identifier: Apache-2.0
import { SUBAGENT_TYPES } from './subagent-runtime.js';

/** Public NND catalog: supported roles and running configuration, not grants. */
export function nndAgentInventory(config) {
  const route = config.routes.subagent;
  return Object.freeze({
    version: 1, state: 'configured',
    route: Object.freeze({ providerID: route.providerId, modelID: route.model }),
    roles: Object.freeze(SUBAGENT_TYPES.map((id) => Object.freeze({ id, kind: 'built_in_subagent' }))),
  });
}
