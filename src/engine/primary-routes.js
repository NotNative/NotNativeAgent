// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { emitEngineStatus } from './output.js';

export async function preparePrimaryRoutes(engine, active) {
  const routes = engine.router.candidates('primary', { requiredCapabilities: ['tools'] });
  if (routes.length === 0) throw new ContractError('route_capability_unavailable', 'no Primary provider route supports tool calls');
  active.sessionId = engine.sessionId;
  await emitEngineStatus(engine, 'waiting_provider', active);
  return routes;
}
