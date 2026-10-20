// SPDX-License-Identifier: Apache-2.0
import { modelStepRequestOptions, providerRequest } from './runtime-helpers.js';

export function primaryProviderRequest(engine, route, context, reasoningMode, active) {
  const routeBudget = engine.reliability.planContextBudget(engine.config, [route], active.runtimeModel, active.contextRetryScale);
  return providerRequest(engine, route, context, modelStepRequestOptions(reasoningMode, active, routeBudget));
}
