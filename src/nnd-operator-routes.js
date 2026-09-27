// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const SESSION_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/capabilities$/u;
const STEER_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/steer$/u;
const GOAL_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/goal$/u;
const GOAL_EVIDENCE_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/goal-evidence$/u;
const GOAL_AUDIT_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/goal-audit$/u;
const WALKTHROUGH_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/walkthrough$/u;

export async function dispatchNndOperatorRequest(request, response, context) {
  const capability = SESSION_ROUTE.exec(context.url.pathname);
  const steer = STEER_ROUTE.exec(context.url.pathname);
  const goal = GOAL_ROUTE.exec(context.url.pathname);
  const goalEvidence = GOAL_EVIDENCE_ROUTE.exec(context.url.pathname);
  const goalAudit = GOAL_AUDIT_ROUTE.exec(context.url.pathname);
  const walkthrough = WALKTHROUGH_ROUTE.exec(context.url.pathname);
  if (!capability && !steer && !goal && !goalEvidence && !goalAudit && !walkthrough) return false;
  const encoded = (capability ?? steer ?? goal ?? goalEvidence ?? goalAudit ?? walkthrough)[1];
  let sessionId;
  try { sessionId = decodeURIComponent(encoded); requireExternalId(sessionId, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  if (goal) return dispatchGoalRequest(request, response, context, sessionId);
  if (goalEvidence) {
    if (request.method !== 'GET') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
    requireIntegrationPermission(context.principal, 'nnd.read');
    return send(response, 200, context.nndEngineHost.goalEvidence(sessionId, context.principal));
  }
  if (goalAudit) {
    if (request.method !== 'POST') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
    requireIntegrationPermission(context.principal, 'nnd.goal.manage');
    if (!context.nndEngineHost?.auditGoal) throw new ContractError('nnd_engine_unavailable', 'NND goal auditor is unavailable');
    return send(response, 200, await context.nndEngineHost.auditGoal(sessionId, context.principal, await readJsonBody(request)));
  }
  if (walkthrough) {
    if (request.method !== 'POST') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
    requireIntegrationPermission(context.principal, 'nnd.walkthrough.generate');
    if (!context.nndEngineHost?.generateWalkthrough) throw new ContractError('nnd_engine_unavailable', 'NND walkthrough generation is unavailable');
    return send(response, 200, await context.nndEngineHost.generateWalkthrough(sessionId, context.principal, await readJsonBody(request)));
  }
  if (request.method === 'GET' && capability) requireIntegrationPermission(context.principal, 'nnd.read');
  else if (request.method === 'POST' && steer) requireIntegrationPermission(context.principal, 'nnd.steer');
  else return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  const resolver = context.nndSessionResolver;
  if (typeof resolver !== 'function') throw new ContractError('nnd_engine_unavailable', 'NND session resolver is unavailable');
  const session = await resolver(sessionId, context.principal);
  if (!session || session.sessionId !== sessionId) return send(response, 404, { error: { code: 'session_unavailable', message: 'session is unavailable' } });
  if (request.method === 'GET' && capability) {
    return send(response, 200, { session_id: sessionId, revision: session.revision ?? 1, capabilities: { steer_subagent: session.steerSubagent === true }, availability: session.availability ?? 'unavailable' });
  }
  if (request.method === 'POST' && steer) {
    if (session.steerSubagent !== true || typeof session.steer !== 'function') {
      return send(response, 409, { error: { code: 'steering_unavailable', message: 'session has no active steering grant' } });
    }
    const body = await readJsonBody(request);
    return send(response, 202, await session.steer(body, context.principal));
  }
}

async function dispatchGoalRequest(request, response, context, sessionId) {
  const host = context.nndEngineHost;
  if (!host || typeof host.goal !== 'function') {
    throw new ContractError('nnd_engine_unavailable', 'NND goal storage is unavailable');
  }
  if (request.method === 'GET') {
    requireIntegrationPermission(context.principal, 'nnd.read');
    return send(response, 200, host.goal(sessionId, context.principal));
  }
  if (request.method !== 'PUT' && request.method !== 'DELETE') {
    return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  }
  requireIntegrationPermission(context.principal, 'nnd.goal.manage');
  const body = await readJsonBody(request);
  const fields = request.method === 'PUT' ? ['goal', 'expected_id', 'expected_revision'] : ['expected_id', 'expected_revision'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length || fields.some((field) => !Object.hasOwn(body, field))) {
    throw new ContractError('nnd_goal_invalid', 'NND goal request has invalid fields');
  }
  const result = request.method === 'PUT'
    ? await host.setGoal(sessionId, context.principal, body.goal, body.expected_id, body.expected_revision)
    : await host.clearGoal(sessionId, context.principal, body.expected_id, body.expected_revision);
  return send(response, 200, result);
}
