// SPDX-License-Identifier: Apache-2.0
import { admittedWorkspaceContext } from './desktop-workspace-request-context.js';
import { ContractError, requireExternalId } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const SESSION_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/capabilities$/u;
const STEER_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/steer$/u;
const GOAL_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/goal$/u;
const GOAL_EVIDENCE_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/goal-evidence$/u;
const GOAL_AUDIT_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/goal-audit$/u;
const WALKTHROUGH_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/walkthrough$/u;
const REVIEW_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/review-mode$/u;

export async function dispatchDesktopOperatorRequest(request, response, context) {
  const capability = SESSION_ROUTE.exec(context.url.pathname);
  const steer = STEER_ROUTE.exec(context.url.pathname);
  const goal = GOAL_ROUTE.exec(context.url.pathname);
  const goalEvidence = GOAL_EVIDENCE_ROUTE.exec(context.url.pathname);
  const goalAudit = GOAL_AUDIT_ROUTE.exec(context.url.pathname);
  const walkthrough = WALKTHROUGH_ROUTE.exec(context.url.pathname);
  const review = REVIEW_ROUTE.exec(context.url.pathname);
  if (!capability && !steer && !goal && !goalEvidence && !goalAudit && !walkthrough && !review) return false;
  context = await admittedWorkspaceContext(context);
  const encoded = (capability ?? steer ?? goal ?? goalEvidence ?? goalAudit ?? walkthrough ?? review)[1];
  let sessionId;
  try { sessionId = decodeURIComponent(encoded); requireExternalId(sessionId, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  if (review) return dispatchReviewRequest(request, response, context, sessionId);
  if (goal) return dispatchGoalRequest(request, response, context, sessionId);
  if (goalEvidence) {
    if (request.method !== 'GET') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
    requireIntegrationPermission(context.principal, 'desktop.read');
    return send(response, 200, context.desktopEngineHost.goalEvidence(sessionId, context.principal));
  }
  if (goalAudit) {
    if (request.method !== 'POST') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
    requireIntegrationPermission(context.principal, 'desktop.goal.manage');
    if (!context.desktopEngineHost?.auditGoal) throw new ContractError('desktop_engine_unavailable', 'desktop goal auditor is unavailable');
    return send(response, 200, await context.desktopEngineHost.auditGoal(sessionId, context.principal, await readJsonBody(request)));
  }
  if (walkthrough) {
    if (request.method !== 'POST') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
    requireIntegrationPermission(context.principal, 'desktop.walkthrough.generate');
    if (!context.desktopEngineHost?.generateWalkthrough) throw new ContractError('desktop_engine_unavailable', 'desktop walkthrough generation is unavailable');
    return send(response, 200, await context.desktopEngineHost.generateWalkthrough(sessionId, context.principal, await readJsonBody(request)));
  }
  if (request.method === 'GET' && capability) requireIntegrationPermission(context.principal, 'desktop.read');
  else if (request.method === 'POST' && steer) requireIntegrationPermission(context.principal, 'desktop.steer');
  else return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  const resolver = context.desktopSessionResolver;
  if (typeof resolver !== 'function') throw new ContractError('desktop_engine_unavailable', 'desktop session resolver is unavailable');
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

async function dispatchReviewRequest(request, response, context, sessionId) {
  const host = context.desktopEngineHost;
  if (!host?.reviewMode) throw new ContractError('desktop_engine_unavailable', 'desktop review mode is unavailable');
  if (request.method === 'GET') {
    requireIntegrationPermission(context.principal, 'desktop.read');
    return send(response, 200, host.reviewMode(sessionId, context.principal));
  }
  if (request.method !== 'PUT') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'desktop.session.update');
  return send(response, 200, await host.setReviewMode(sessionId, context.principal, await readJsonBody(request)));
}

async function dispatchGoalRequest(request, response, context, sessionId) {
  const host = context.desktopEngineHost;
  if (!host || typeof host.goal !== 'function') {
    throw new ContractError('desktop_engine_unavailable', 'desktop goal storage is unavailable');
  }
  if (request.method === 'GET') {
    requireIntegrationPermission(context.principal, 'desktop.read');
    return send(response, 200, host.goal(sessionId, context.principal));
  }
  if (request.method !== 'PUT' && request.method !== 'DELETE') {
    return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  }
  requireIntegrationPermission(context.principal, 'desktop.goal.manage');
  const body = await readJsonBody(request);
  const fields = request.method === 'PUT' ? ['goal', 'expected_id', 'expected_revision'] : ['expected_id', 'expected_revision'];
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== fields.length || fields.some((field) => !Object.hasOwn(body, field))) {
    throw new ContractError('desktop_goal_invalid', 'desktop goal request has invalid fields');
  }
  const result = request.method === 'PUT'
    ? await host.setGoal(sessionId, context.principal, body.goal, body.expected_id, body.expected_revision)
    : await host.clearGoal(sessionId, context.principal, body.expected_id, body.expected_revision);
  return send(response, 200, result);
}
