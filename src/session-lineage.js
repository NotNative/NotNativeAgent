// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from 'node:util';
import { ContractError, newId, requireExternalId } from './ids.js';
import { persistEngineRecord } from './engine/persistence.js';

const MAX_CHILD_SESSIONS = 1024;

export function createSessionLineage(engine, childSessionId, agentType, launch = {}) {
  return validateSessionLineage({
    schema: 'nna.session-lineage.v1', child_session_id: childSessionId,
    parent_session_id: engine.sessionId, parent_turn_id: engine.active?.turnId ?? null,
    parent_step_id: engine.active?.stepId ?? null,
    launching_tool_request_id: launch.toolRequestId ?? null,
    agent_run_id: newId('agent_run'), parent_agent_run_id: engine.sessionLineage?.agent_run_id ?? null,
    agent_type: agentType, created_at: new Date().toISOString(),
  }, childSessionId);
}

export function validateSessionLineage(value, childSessionId) {
  if (value === null || value === undefined) return null;
  if (value.schema !== 'nna.session-lineage.v1' || value.child_session_id !== childSessionId
    || value.parent_session_id === childSessionId || !['general', 'planner', 'coder', 'tester', 'reviewer'].includes(value.agent_type)) {
    throw new ContractError('session_history_invalid', 'session lineage is invalid');
  }
  for (const key of ['child_session_id', 'parent_session_id', 'agent_run_id']) requireExternalId(value[key], key);
  for (const key of ['parent_turn_id', 'parent_step_id', 'launching_tool_request_id', 'parent_agent_run_id']) {
    if (value[key] !== null) requireExternalId(value[key], key);
  }
  if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) {
    throw new ContractError('session_history_invalid', 'session lineage creation time is invalid');
  }
  return Object.freeze(Object.fromEntries(['schema', 'child_session_id', 'parent_session_id', 'parent_turn_id',
    'parent_step_id', 'launching_tool_request_id', 'agent_run_id', 'parent_agent_run_id', 'agent_type', 'created_at']
    .map((key) => [key, value[key]])));
}

export function restoreSessionLineage(engine, headerRecords) {
  const prior = validateSessionLineage(headerRecords?.[0]?.payload?.lineage, engine.sessionId);
  if (engine.sessionLineage && !isDeepStrictEqual(engine.sessionLineage, prior)) {
    throw new ContractError('session_history_invalid', 'session lineage does not match the durable session');
  }
  engine.sessionLineage = prior;
  engine.telemetry.agentRunId = prior?.agent_run_id ?? null;
  engine.telemetry.parentAgentRunId = prior?.parent_agent_run_id ?? null;
  if (prior) engine.telemetry.conversationId = prior.parent_session_id;
}

export async function recordChildSession(engine, lineage, state) {
  engine.childSessions ??= new Map();
  if (!engine.childSessions.has(lineage.child_session_id) && engine.childSessions.size >= MAX_CHILD_SESSIONS) {
    throw new ContractError('subagent_execution_failed', 'session child association capacity is exhausted');
  }
  const record = Object.freeze({ ...lineage, state, updated_at: new Date().toISOString() });
  await persistEngineRecord(engine, 'subagent_session', record);
  engine.childSessions.set(lineage.child_session_id, record);
  try { engine.telemetry?.record('subagent.session', state === 'created' ? 'started' : state === 'running' ? 'measured'
    : state === 'completed' ? 'succeeded' : state, record, {
    turnId: lineage.parent_turn_id, stepId: lineage.parent_step_id,
    toolRequestId: lineage.launching_tool_request_id, agentRunId: lineage.agent_run_id,
    parentAgentRunId: lineage.parent_agent_run_id, spanId: `subagent:${lineage.agent_run_id}`,
  }); } catch { /* Telemetry cannot replace the durable association outcome. */ }
}
