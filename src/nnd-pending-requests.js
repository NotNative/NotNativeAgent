// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { requireQuestionBatch } from './question-broker.js';

/** Security: observe broker identities and questions without exposing tool arguments or granting a decision voice. */
export function pendingRequests(engine) {
  if (engine === null) return { permissions: [], forms: [], capabilities: { permissions: 'unsupported', forms: 'unsupported' } };
  const permissions = brokerSnapshot(engine.permissionBroker).map((item) => {
    requireExternalId(item.token, 'permission_token');
    requireExternalId(item.requestId, 'tool_request_id');
    if (typeof item.tool !== 'string' || !item.tool || item.tool.length > 256 || !Number.isSafeInteger(item.expiresAt)) unavailable();
    return { id: item.token, toolRequestID: item.requestId, permission: item.tool, expiresAt: item.expiresAt };
  });
  const forms = brokerSnapshot(engine.questionBroker).map((item) => {
    requireExternalId(item.token, 'question_token');
    requireExternalId(item.tool_request_id, 'tool_request_id');
    return { id: item.token, toolRequestID: item.tool_request_id, questions: requireQuestionBatch({ questions: item.questions }) };
  });
  return { permissions, forms, capabilities: {
    permissions: engine.permissionBroker === null ? 'unsupported' : 'observe-only',
    forms: engine.questionBroker === null ? 'unsupported' : 'observe-only',
  } };
}

export function ownedPendingRequests(contexts, children, principal, owns) {
  const sessions = Object.create(null);
  for (const context of contexts.values()) {
    if (!context.closing && owns(context, principal)) sessions[context.sessionId] = pendingRequests(context.engine);
  }
  Object.assign(sessions, children.pendingRequests(principal));
  if (Object.keys(sessions).length > 5000 || Buffer.byteLength(JSON.stringify(sessions), 'utf8') > 2_097_152) unavailable();
  return { coverage: 'complete', sessions };
}

function brokerSnapshot(broker) {
  if (broker === null) return [];
  if (!broker || typeof broker.snapshot !== 'function') unavailable();
  const items = broker.snapshot();
  if (!Array.isArray(items) || items.length > 128 || items.some((item) => !item || typeof item !== 'object')) unavailable();
  return items;
}
function unavailable() { throw new ContractError('nnd_pending_unavailable', 'NND pending request observation is unavailable'); }
